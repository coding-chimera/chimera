//! IPC v0 connection layer: framed reads and writes over a byte stream.
//!
//! Contract: `packages/chimera/specs/rust-host/ipc-v0.md` §3.1 (length-prefixed
//! stream), §7.3 (`transport_sequence` continuity) and §9.1 (backpressure
//! principles).
//!
//! - [`FrameWriter`] writes whole frames and stamps the send direction's
//!   `transport_sequence`: it starts at 1, increments once per written frame,
//!   and resets by opening a new writer on reconnect (§1.1).
//! - [`FrameReader`] buffers bytes in whatever granularity the transport
//!   delivers. A partial header or body is not an error; only a frame that
//!   cannot fit in the bounded buffer, a malformed header, or a durable
//!   sequence discontinuity is.
//! - [`MessageReader`] composes the reader with [`Reassembler`], so a logical
//!   message split across `MORE` frames comes out as one body.
//!
//! Backpressure is deliberately a skeleton here: write errors propagate, and
//! the read side exposes [`FrameReader::pending_bytes`] /
//! [`FrameReader::pending_frames`] so the caller can stop reading. Queueing,
//! blocking, and the drop policy for transient frames belong to the caller
//! (§9.1); this module never blocks on a full queue and never discards frames.

use std::io::{self, Read, Write};

use crate::frame::{
    decode_header, FrameError, Header, Reassembler, FLAG_DURABLE, HEADER_LEN, MAX_FRAME_BYTES,
};

/// Read-buffer ceiling: one maximum-size frame (header + body), §3.1.
pub const READER_BUFFER_LIMIT: usize = MAX_FRAME_BYTES as usize + HEADER_LEN as usize;

/// Chunk size used to pull bytes off the transport. Small enough to keep the
/// buffer close to the frame being assembled, large enough to amortize reads.
const READ_CHUNK_BYTES: usize = 8 * 1024;

/// A connection-layer failure: a frame/protocol error or an I/O failure.
///
/// Stable `code()`/`category()` values mirror §10.2. I/O failures carry no
/// protocol code and are reported as `io_error` / `transport`.
#[derive(Debug)]
pub enum ConnectionError {
    /// A frame-level or sequence-level protocol failure.
    Frame(FrameError),
    /// The underlying transport failed to read or write.
    Io(io::Error),
}

impl ConnectionError {
    /// Stable §10.2 error code.
    pub fn code(&self) -> &'static str {
        match self {
            ConnectionError::Frame(err) => err.code(),
            ConnectionError::Io(_) => "io_error",
        }
    }

    /// §10.2 category.
    pub fn category(&self) -> &'static str {
        match self {
            ConnectionError::Frame(err) => err.category(),
            ConnectionError::Io(_) => "transport",
        }
    }

    /// The frame error, when this failure came from the codec or sequencing.
    pub fn as_frame_error(&self) -> Option<FrameError> {
        match self {
            ConnectionError::Frame(err) => Some(*err),
            ConnectionError::Io(_) => None,
        }
    }
}

impl From<FrameError> for ConnectionError {
    fn from(err: FrameError) -> Self {
        ConnectionError::Frame(err)
    }
}

impl From<io::Error> for ConnectionError {
    fn from(err: io::Error) -> Self {
        ConnectionError::Io(err)
    }
}

impl core::fmt::Display for ConnectionError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            ConnectionError::Frame(err) => err.fmt(f),
            ConnectionError::Io(err) => write!(f, "io_error: {}", err),
        }
    }
}

impl std::error::Error for ConnectionError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            ConnectionError::Frame(err) => Some(err),
            ConnectionError::Io(err) => Some(err),
        }
    }
}

/// Writes complete frames and owns the send direction's `transport_sequence`.
///
/// The writer overwrites `header.sequence` on every call; callers must not set
/// it themselves. `connection_id` and `worker_generation` are left untouched so
/// the handshake (`connection_id == 0` on the first `hello`) and post-handshake
/// identity are the caller's decision.
#[derive(Debug)]
pub struct FrameWriter<W: Write> {
    inner: W,
    next_sequence: u64,
}

impl<W: Write> FrameWriter<W> {
    /// A writer whose first frame carries `transport_sequence == 1`.
    pub fn new(inner: W) -> Self {
        Self {
            inner,
            next_sequence: 1,
        }
    }

    /// Sequence the next written frame will carry.
    pub fn next_sequence(&self) -> u64 {
        self.next_sequence
    }

    /// Write one complete frame and return the sequence it carried.
    ///
    /// `header.sequence` is replaced with [`FrameWriter::next_sequence`]. The
    /// sequence advances only after the whole frame was written, so an I/O
    /// failure never consumes a sequence number.
    ///
    /// Returns [`FrameError::FrameTooLarge`] instead of panicking when `payload`
    /// exceeds [`MAX_FRAME_BYTES`]; callers must split into `MORE` fragments.
    pub fn write_frame(
        &mut self,
        mut header: Header,
        payload: &[u8],
    ) -> Result<u64, ConnectionError> {
        if payload.len() > MAX_FRAME_BYTES as usize {
            return Err(FrameError::FrameTooLarge.into());
        }
        header.sequence = self.next_sequence;
        self.inner.write_all(&header.encode(payload))?;
        let sequence = self.next_sequence;
        self.next_sequence = self.next_sequence.wrapping_add(1);
        Ok(sequence)
    }

    /// Flush the underlying transport, propagating write errors (§9.1).
    pub fn flush(&mut self) -> Result<(), ConnectionError> {
        self.inner.flush()?;
        Ok(())
    }

    /// Borrow the underlying transport.
    pub fn get_ref(&self) -> &W {
        &self.inner
    }

    /// Mutably borrow the underlying transport.
    pub fn get_mut(&mut self) -> &mut W {
        &mut self.inner
    }

    /// Consume the writer and return the underlying transport.
    pub fn into_inner(self) -> W {
        self.inner
    }
}

/// Incremental frame reader over an arbitrary byte stream.
///
/// The reader pulls bytes as needed and keeps whatever does not yet form a
/// complete frame. Any arrival granularity works: one byte at a time, random
/// splits, or many frames in one read. The buffer is capped at
/// [`READER_BUFFER_LIMIT`] (one maximum-size frame); a header that would need
/// more than the cap is rejected with `frame_too_large` before its body is
/// buffered, so a hostile length prefix cannot grow memory.
///
/// Sequence continuity (§7.3) is enforced on the receive direction:
///
/// - a transient frame with an unexpected sequence increments
///   [`FrameReader::gap_count`] and is still returned, with the expected
///   sequence resynchronized past it;
/// - a `DURABLE` frame with an unexpected sequence returns
///   [`FrameError::SequenceGap`] and the frame is not returned.
///
/// The reader does not deduplicate: a sequence at or below the expected value
/// is a discontinuity here, and `(connection_id, transport_sequence)` dedupe is
/// the caller's job (§8.2).
#[derive(Debug)]
pub struct FrameReader<R: Read> {
    inner: R,
    buf: Vec<u8>,
    expected_sequence: u64,
    gaps: u64,
    max_buffer_bytes: usize,
}

impl<R: Read> FrameReader<R> {
    /// A reader with the v0 candidate default buffer ceiling.
    pub fn new(inner: R) -> Self {
        Self::with_buffer_limit(inner, READER_BUFFER_LIMIT)
    }

    /// A reader with an explicit buffer ceiling.
    ///
    /// Useful when `hello` negotiated a `max_frame_bytes` below the host hard
    /// limit. The limit is raised to at least [`HEADER_LEN`] so a header can
    /// always be inspected.
    pub fn with_buffer_limit(inner: R, max_buffer_bytes: usize) -> Self {
        Self {
            inner,
            buf: Vec::new(),
            expected_sequence: 1,
            gaps: 0,
            max_buffer_bytes: max_buffer_bytes.max(HEADER_LEN as usize),
        }
    }

    /// Next `transport_sequence` this reader expects.
    pub fn expected_sequence(&self) -> u64 {
        self.expected_sequence
    }

    /// Number of transient sequence gaps observed so far (§7.3).
    pub fn gap_count(&self) -> u64 {
        self.gaps
    }

    /// Bytes currently buffered but not yet consumed.
    pub fn pending_bytes(&self) -> usize {
        self.buf.len()
    }

    /// Complete frames currently sitting in the buffer.
    ///
    /// Counts only frames that can be parsed without further reads; an
    /// incomplete header/body is not counted. Combined with
    /// [`FrameReader::pending_bytes`], this is the read-side backpressure
    /// signal (§9.1): a caller can stop reading when either value is high.
    pub fn pending_frames(&self) -> usize {
        let mut offset = 0;
        let mut frames = 0;
        while offset + HEADER_LEN as usize <= self.buf.len() {
            let header = match decode_header(&self.buf[offset..offset + HEADER_LEN as usize]) {
                Ok(header) => header,
                Err(_) => break,
            };
            let total = HEADER_LEN as usize + header.payload_length as usize;
            if offset + total > self.buf.len() {
                break;
            }
            frames += 1;
            offset += total;
        }
        frames
    }

    /// Read the next complete frame.
    ///
    /// Returns `Ok(None)` on a clean EOF at a frame boundary. A partial frame
    /// followed by EOF is `decode_error`.
    pub fn next_frame(&mut self) -> Result<Option<(Header, Vec<u8>)>, ConnectionError> {
        loop {
            if let Some((header, payload)) = self.parse_buffered()? {
                self.accept_sequence(&header)?;
                return Ok(Some((header, payload)));
            }
            if !self.fill()? {
                if self.buf.is_empty() {
                    return Ok(None);
                }
                return Err(FrameError::DecodeError.into());
            }
        }
    }

    /// Consume the reader and return the underlying transport.
    pub fn into_inner(self) -> R {
        self.inner
    }

    /// Borrow the underlying transport.
    pub fn get_ref(&self) -> &R {
        &self.inner
    }

    /// Take the next complete frame out of the buffer, if one is fully present.
    fn parse_buffered(&mut self) -> Result<Option<(Header, Vec<u8>)>, ConnectionError> {
        let header_len = HEADER_LEN as usize;
        if self.buf.len() < header_len {
            return Ok(None);
        }
        let header = decode_header(&self.buf[..header_len])?;
        let total = header_len + header.payload_length as usize;
        if total > self.max_buffer_bytes {
            return Err(FrameError::FrameTooLarge.into());
        }
        if self.buf.len() < total {
            return Ok(None);
        }
        let payload = self.buf[header_len..total].to_vec();
        self.buf.drain(..total);
        Ok(Some((header, payload)))
    }

    /// Pull one chunk from the transport. `Ok(false)` means EOF.
    fn fill(&mut self) -> Result<bool, ConnectionError> {
        let remaining = self.max_buffer_bytes.saturating_sub(self.buf.len());
        if remaining == 0 {
            // A frame boundary is always consumed by `parse_buffered`, so this
            // only happens with a malformed stream that never completes a frame.
            return Err(FrameError::FrameTooLarge.into());
        }
        let mut chunk = [0u8; READ_CHUNK_BYTES];
        let capacity = remaining.min(chunk.len());
        loop {
            match self.inner.read(&mut chunk[..capacity]) {
                Ok(0) => return Ok(false),
                Ok(read) => {
                    self.buf.extend_from_slice(&chunk[..read]);
                    return Ok(true);
                }
                Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
                Err(err) => return Err(err.into()),
            }
        }
    }

    /// Validate and advance the receive-direction `transport_sequence` (§7.3).
    fn accept_sequence(&mut self, header: &Header) -> Result<(), FrameError> {
        if header.sequence == self.expected_sequence {
            self.expected_sequence = self.expected_sequence.wrapping_add(1);
            return Ok(());
        }
        if header.flags & FLAG_DURABLE != 0 {
            return Err(FrameError::SequenceGap {
                expected: self.expected_sequence,
                received: header.sequence,
            });
        }
        self.gaps = self.gaps.wrapping_add(1);
        self.expected_sequence = header.sequence.wrapping_add(1);
        Ok(())
    }
}

/// Frames plus `MORE` reassembly, yielding one logical message at a time.
///
/// This is the explicit composition entry point for callers that want message
/// bodies rather than frames. Sequence validation stays in [`FrameReader`] and
/// fragment limits stay in [`Reassembler`]; nothing is duplicated here.
#[derive(Debug)]
pub struct MessageReader<R: Read> {
    frames: FrameReader<R>,
    reassembler: Reassembler,
}

impl<R: Read> MessageReader<R> {
    /// A message reader with the v0 candidate default limits.
    pub fn new(inner: R) -> Self {
        Self {
            frames: FrameReader::new(inner),
            reassembler: Reassembler::new(),
        }
    }

    /// A message reader with an explicit frame-buffer ceiling.
    pub fn with_buffer_limit(inner: R, max_buffer_bytes: usize) -> Self {
        Self {
            frames: FrameReader::with_buffer_limit(inner, max_buffer_bytes),
            reassembler: Reassembler::new(),
        }
    }

    /// Read the next complete logical message.
    ///
    /// Returns `Ok(None)` on a clean EOF at a message boundary. EOF in the
    /// middle of a `MORE` message is `decode_error`.
    pub fn next_message(&mut self) -> Result<Option<Vec<u8>>, ConnectionError> {
        loop {
            let Some((header, payload)) = self.frames.next_frame()? else {
                if self.reassembler.fragments() != 0 {
                    return Err(FrameError::DecodeError.into());
                }
                return Ok(None);
            };
            if let Some(body) = self.reassembler.push(&header, &payload)? {
                return Ok(Some(body));
            }
        }
    }

    /// Borrow the underlying frame reader (sequence counters, pending counts).
    pub fn frames(&self) -> &FrameReader<R> {
        &self.frames
    }

    /// Mutably borrow the underlying frame reader.
    pub fn frames_mut(&mut self) -> &mut FrameReader<R> {
        &mut self.frames
    }

    /// Borrow the reassembler (fragment limits, compression negotiation).
    pub fn reassembler(&self) -> &Reassembler {
        &self.reassembler
    }

    /// Mutably borrow the reassembler.
    pub fn reassembler_mut(&mut self) -> &mut Reassembler {
        &mut self.reassembler
    }

    /// Consume the message reader and return the underlying transport.
    pub fn into_inner(self) -> R {
        self.frames.into_inner()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame::{
        FrameKind, PROTOCOL_VERSION_V0, FLAG_CHECKSUM, FLAG_FINAL, FLAG_MORE,
    };

    fn header(sequence: u64, flags: u16) -> Header {
        Header {
            protocol_version: PROTOCOL_VERSION_V0,
            frame_kind: FrameKind::Event,
            flags,
            payload_length: 0,
            connection_id: 1,
            worker_generation: 7,
            sequence,
            correlation_id: [0; 16],
            payload_crc32c: 0,
        }
    }

    fn frame_bytes(sequence: u64, flags: u16, payload: &[u8]) -> Vec<u8> {
        header(sequence, flags).encode(payload)
    }

    /// Concatenate frames written through a `FrameWriter`.
    fn write_frames(frames: &[(u16, &[u8])]) -> Vec<u8> {
        let mut writer = FrameWriter::new(Vec::new());
        for (flags, payload) in frames {
            writer
                .write_frame(header(0, *flags), payload)
                .expect("in-memory write");
        }
        writer.into_inner()
    }

    /// A reader that hands out at most `chunk` bytes per `read` call, or a
    /// deterministic 1..=7 byte pattern when `random` is set.
    struct Chunked {
        data: Vec<u8>,
        pos: usize,
        chunk: usize,
        random: bool,
        state: u64,
    }

    impl Chunked {
        fn fixed(data: Vec<u8>, chunk: usize) -> Self {
            Self {
                data,
                pos: 0,
                chunk,
                random: false,
                state: 0,
            }
        }

        fn random(data: Vec<u8>) -> Self {
            Self {
                data,
                pos: 0,
                chunk: 1,
                random: true,
                state: 0x9E37_79B9_7F4A_7C15,
            }
        }
    }

    impl Read for Chunked {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            if self.pos >= self.data.len() {
                return Ok(0);
            }
            let want = if self.random {
                let mut x = self.state;
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                self.state = x;
                (x % 7 + 1) as usize
            } else {
                self.chunk
            };
            let count = want
                .min(buf.len())
                .min(self.data.len() - self.pos);
            buf[..count].copy_from_slice(&self.data[self.pos..self.pos + count]);
            self.pos += count;
            Ok(count)
        }
    }

    fn read_all(bytes: Vec<u8>, chunk: usize) -> Vec<(Header, Vec<u8>)> {
        let mut reader = FrameReader::new(Chunked::fixed(bytes, chunk));
        let mut frames = Vec::new();
        while let Some(frame) = reader.next_frame().expect("frame decodes") {
            frames.push(frame);
        }
        frames
    }

    #[test]
    fn whole_frame_passes_through() {
        let bytes = write_frames(&[(0, b"alpha"), (FLAG_DURABLE, b"beta")]);
        let mut reader = FrameReader::new(io::Cursor::new(bytes));

        let (first, payload) = reader.next_frame().expect("first frame").expect("present");
        assert_eq!(first.sequence, 1);
        assert_eq!(first.flags, 0);
        assert_eq!(payload, b"alpha");

        let (second, payload) = reader.next_frame().expect("second frame").expect("present");
        assert_eq!(second.sequence, 2);
        assert_eq!(second.flags, FLAG_DURABLE);
        assert_eq!(payload, b"beta");

        assert!(reader.next_frame().expect("clean eof").is_none());
        assert_eq!(reader.expected_sequence(), 3);
        assert_eq!(reader.gap_count(), 0);
    }

    #[test]
    fn writer_stamps_sequence_from_one() {
        let mut writer = FrameWriter::new(Vec::new());
        assert_eq!(writer.next_sequence(), 1);
        assert_eq!(writer.write_frame(header(99, 0), b"a").expect("write"), 1);
        assert_eq!(writer.write_frame(header(0, 0), b"b").expect("write"), 2);
        assert_eq!(writer.next_sequence(), 3);

        let bytes = writer.into_inner();
        let mut reader = FrameReader::new(io::Cursor::new(bytes));
        assert_eq!(reader.next_frame().expect("read").expect("present").0.sequence, 1);
        assert_eq!(reader.next_frame().expect("read").expect("present").0.sequence, 2);
    }

    #[test]
    fn byte_by_byte_feeding_restores_frames() {
        let bytes = write_frames(&[
            (0, b"first payload"),
            (FLAG_DURABLE | FLAG_CHECKSUM, b"second payload"),
            (FLAG_MORE, b""),
        ]);
        let frames = read_all(bytes, 1);
        assert_eq!(frames.len(), 3);
        assert_eq!(frames[0].1, b"first payload");
        assert_eq!(frames[1].1, b"second payload");
        assert_eq!(frames[2].1, b"");
        assert_eq!(frames[2].0.sequence, 3);
    }

    #[test]
    fn random_split_points_restore_frames() {
        let payloads: Vec<Vec<u8>> = (0..16)
            .map(|index| vec![index as u8; index * 13])
            .collect();
        let mut expected = Vec::new();
        let mut bytes = Vec::new();
        let mut writer = FrameWriter::new(Vec::new());
        for payload in &payloads {
            writer
                .write_frame(header(0, 0), payload)
                .expect("in-memory write");
            expected.push(payload.clone());
        }
        bytes.extend_from_slice(&writer.into_inner());

        let mut reader = FrameReader::new(Chunked::random(bytes));
        for (index, payload) in expected.iter().enumerate() {
            let (frame, body) = reader.next_frame().expect("read").expect("present");
            assert_eq!(frame.sequence, index as u64 + 1);
            assert_eq!(&body, payload);
        }
        assert!(reader.next_frame().expect("clean eof").is_none());
    }

    #[test]
    fn multiple_frames_in_one_read_are_counted_as_pending() {
        let bytes = write_frames(&[(0, b"one"), (0, b"two"), (0, b"three")]);
        let mut reader = FrameReader::new(io::Cursor::new(bytes.clone()));
        let (_, payload) = reader.next_frame().expect("read").expect("present");
        assert_eq!(payload, b"one");

        let tail = bytes.len() - (HEADER_LEN as usize + 3);
        assert_eq!(reader.pending_frames(), 2);
        assert_eq!(reader.pending_bytes(), tail);

        assert_eq!(reader.next_frame().expect("read").expect("present").1, b"two");
        assert_eq!(reader.pending_frames(), 1);
        assert_eq!(reader.next_frame().expect("read").expect("present").1, b"three");
        assert_eq!(reader.pending_frames(), 0);
        assert_eq!(reader.pending_bytes(), 0);
    }

    #[test]
    fn half_frame_then_eof_is_decode_error() {
        let bytes = write_frames(&[(0, b"truncated body")]);
        let mut reader = FrameReader::new(Chunked::fixed(bytes[..bytes.len() - 1].to_vec(), 3));
        assert_eq!(
            reader.next_frame().err().and_then(|err| err.as_frame_error()),
            Some(FrameError::DecodeError)
        );

        // A truncated header behaves the same way.
        let bytes = write_frames(&[(0, b"x")]);
        let mut reader = FrameReader::new(Chunked::fixed(bytes[..20].to_vec(), 2));
        assert_eq!(
            reader.next_frame().err().and_then(|err| err.as_frame_error()),
            Some(FrameError::DecodeError)
        );
    }

    #[test]
    fn empty_stream_is_clean_eof() {
        let mut reader = FrameReader::new(io::Cursor::new(Vec::new()));
        assert!(reader.next_frame().expect("clean eof").is_none());
        assert_eq!(reader.expected_sequence(), 1);
    }

    #[test]
    fn durable_gap_is_sequence_gap() {
        let mut bytes = frame_bytes(1, FLAG_DURABLE, b"first");
        bytes.extend_from_slice(&frame_bytes(3, FLAG_DURABLE, b"third"));
        let mut reader = FrameReader::new(io::Cursor::new(bytes));

        assert_eq!(
            reader.next_frame().expect("first frame").expect("present").1,
            b"first"
        );
        let err = reader.next_frame().expect_err("durable gap rejected");
        assert_eq!(
            err.as_frame_error(),
            Some(FrameError::SequenceGap {
                expected: 2,
                received: 3,
            })
        );
        assert_eq!(err.code(), "sequence_gap");
        assert_eq!(err.category(), "protocol");
        assert_eq!(
            err.to_string(),
            "sequence_gap: expected sequence 2, received 3"
        );
        assert_eq!(reader.gap_count(), 0, "durable gaps are not counted");
    }

    #[test]
    fn transient_gap_is_counted_and_stream_continues() {
        let mut bytes = frame_bytes(1, 0, b"one");
        bytes.extend_from_slice(&frame_bytes(4, 0, b"four"));
        bytes.extend_from_slice(&frame_bytes(5, 0, b"five"));
        let mut reader = FrameReader::new(io::Cursor::new(bytes));

        assert_eq!(reader.next_frame().expect("read").expect("present").0.sequence, 1);
        assert_eq!(reader.next_frame().expect("read").expect("present").0.sequence, 4);
        assert_eq!(reader.gap_count(), 1);
        assert_eq!(reader.expected_sequence(), 5);
        assert_eq!(reader.next_frame().expect("read").expect("present").0.sequence, 5);
        assert_eq!(reader.gap_count(), 1);
        assert!(reader.next_frame().expect("clean eof").is_none());
    }

    #[test]
    fn duplicate_transient_sequence_counts_as_gap() {
        let mut bytes = frame_bytes(1, 0, b"one");
        bytes.extend_from_slice(&frame_bytes(1, 0, b"one again"));
        let mut reader = FrameReader::new(io::Cursor::new(bytes));

        assert!(reader.next_frame().expect("read").is_some());
        assert!(reader.next_frame().expect("read").is_some());
        assert_eq!(reader.gap_count(), 1);
        assert_eq!(reader.expected_sequence(), 2);
    }

    #[test]
    fn buffer_over_limit_is_frame_too_large() {
        // Header alone is valid; the body would exceed the negotiated ceiling.
        let bytes = frame_bytes(1, 0, &[0u8; 200]);
        let mut reader = FrameReader::with_buffer_limit(io::Cursor::new(bytes), 128);
        assert_eq!(
            reader.next_frame().err().and_then(|err| err.as_frame_error()),
            Some(FrameError::FrameTooLarge)
        );
    }

    #[test]
    fn writer_propagates_io_errors_without_consuming_sequence() {
        struct FailingWriter;

        impl Write for FailingWriter {
            fn write(&mut self, _buf: &[u8]) -> io::Result<usize> {
                Err(io::Error::new(io::ErrorKind::BrokenPipe, "closed"))
            }

            fn flush(&mut self) -> io::Result<()> {
                Err(io::Error::new(io::ErrorKind::BrokenPipe, "closed"))
            }
        }

        let mut writer = FrameWriter::new(FailingWriter);
        let err = writer
            .write_frame(header(0, 0), b"payload")
            .expect_err("write fails");
        assert_eq!(err.code(), "io_error");
        assert_eq!(err.category(), "transport");
        assert!(matches!(err, ConnectionError::Io(_)));
        assert_eq!(writer.next_sequence(), 1, "failed write keeps its sequence");
        assert!(writer.flush().is_err());
    }

    #[test]
    fn writer_rejects_oversize_payload() {
        let mut writer = FrameWriter::new(Vec::new());
        let payload = vec![0u8; MAX_FRAME_BYTES as usize + 1];
        assert_eq!(
            writer
                .write_frame(header(0, 0), &payload)
                .err()
                .and_then(|err| err.as_frame_error()),
            Some(FrameError::FrameTooLarge)
        );
        assert_eq!(writer.next_sequence(), 1);
    }

    #[test]
    fn message_reader_reassembles_more_fragments() {
        let mut writer = FrameWriter::new(Vec::new());
        writer
            .write_frame(header(0, FLAG_MORE | FLAG_DURABLE), b"hello ")
            .expect("write");
        writer
            .write_frame(header(0, FLAG_MORE | FLAG_DURABLE | FLAG_FINAL), b"frag")
            .expect("write");
        writer
            .write_frame(header(0, FLAG_DURABLE | FLAG_FINAL), b"ments")
            .expect("write");
        // A second, single-fragment message proves the reader keeps going.
        writer
            .write_frame(header(0, 0), b"tail")
            .expect("write");

        let mut reader = MessageReader::new(io::Cursor::new(writer.into_inner()));
        assert_eq!(
            reader.next_message().expect("message").expect("present"),
            b"hello fragments"
        );
        assert_eq!(reader.next_message().expect("message").expect("present"), b"tail");
        assert!(reader.next_message().expect("clean eof").is_none());
        assert_eq!(reader.frames().expected_sequence(), 5);
    }

    #[test]
    fn message_reader_rejects_truncated_fragment_message() {
        let mut writer = FrameWriter::new(Vec::new());
        writer
            .write_frame(header(0, FLAG_MORE), b"partial")
            .expect("write");
        let mut reader = MessageReader::new(io::Cursor::new(writer.into_inner()));
        assert_eq!(
            reader
                .next_message()
                .err()
                .and_then(|err| err.as_frame_error()),
            Some(FrameError::DecodeError)
        );
    }

    #[test]
    fn message_reader_keeps_durable_gap_rejection() {
        let mut bytes = frame_bytes(1, FLAG_DURABLE | FLAG_MORE, b"part");
        bytes.extend_from_slice(&frame_bytes(3, FLAG_DURABLE, b"rest"));
        let mut reader = MessageReader::new(io::Cursor::new(bytes));
        assert_eq!(
            reader
                .next_message()
                .err()
                .and_then(|err| err.as_frame_error()),
            Some(FrameError::SequenceGap {
                expected: 2,
                received: 3,
            })
        );
    }
}