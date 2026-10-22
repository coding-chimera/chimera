//! IPC v0 frame codec.
//!
//! Contract: `packages/chimera/specs/rust-host/ipc-v0.md` §3 (frame format),
//! §10.2 (error codes) and §16 (test vectors).
//!
//! Every frame is a fixed 64-byte header followed by `payload_length` body
//! bytes. Both sides encode little-endian. Validation is ordered so that the
//! body is never allocated before the length has passed `MAX_FRAME_BYTES`.

use crate::crc32c::crc32c;

/// `0x50494843`, wire bytes `43 48 49 50` ("CHIP").
pub const MAGIC: u32 = 0x5049_4843;
/// `major << 8 | minor`; v0 is major 1, minor 0.
pub const PROTOCOL_VERSION_V0: u16 = 0x0100;
/// Fixed header size in bytes (§3.2).
pub const HEADER_LEN: u16 = 64;
/// Hard per-frame body limit (§3.5, candidate default).
pub const MAX_FRAME_BYTES: u32 = 8 * 1024 * 1024;
/// Absolute body limit a host accepts, even after negotiation (§3.5).
pub const MAX_FRAME_BYTES_HARD: u32 = 16 * 1024 * 1024;
/// Limit for a `MORE`-reassembled logical message (§3.5).
pub const MAX_REASSEMBLED_BYTES: usize = 32 * 1024 * 1024;
/// Maximum fragments in one logical message (§3.5).
pub const MAX_FRAGMENTS: usize = 256;
/// Control JSON body limit (§3.5).
pub const MAX_CONTROL_BODY: u32 = 1024 * 1024;
/// Target size for batched transient delta events (§3.5).
pub const EVENT_BATCH_TARGET: usize = 64 * 1024;
/// Hard limit for one batched event body (§3.5).
pub const EVENT_BATCH_MAX: usize = 512 * 1024;

/// `flags` bit 0: this frame is one fragment of a larger logical message.
pub const FLAG_MORE: u16 = 0x0001;
/// `flags` bit 1: the frame carries content that must be persisted/recoverable.
pub const FLAG_DURABLE: u16 = 0x0002;
/// `flags` bit 2: the frame may enter the host command replay window.
pub const FLAG_REPLAYABLE: u16 = 0x0004;
/// `flags` bit 3: body uses a negotiated compression algorithm.
pub const FLAG_COMPRESSED: u16 = 0x0008;
/// `flags` bit 4: last fragment of a message, or end of a drain/replay range.
pub const FLAG_FINAL: u16 = 0x0010;
/// `flags` bit 5: `payload_crc32c` is valid.
pub const FLAG_CHECKSUM: u16 = 0x0020;
/// All bits defined by v0; any other bit is `bad_header` (§3.4).
pub const KNOWN_FLAGS: u16 = 0x003F;

/// `frame_kind` values defined by v0 (§3.3).
#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FrameKind {
    /// Handshake and capability negotiation (`phase` in the body).
    Hello = 1,
    /// Control request that expects a response.
    Request = 2,
    /// Success/failure response to a `request`.
    Response = 3,
    /// One-way event; durable vs transient is carried by flags.
    Event = 4,
    /// Durable commit, drain, or replay acknowledgement.
    Ack = 5,
    /// Cancel a request/turn/job.
    Cancel = 6,
    /// Graceful drain (host -> worker).
    Drain = 7,
    /// Protocol/connection-level error (not a business response).
    Error = 8,
    /// Replay range marker for unacknowledged durable commands.
    Replay = 9,
}

impl FrameKind {
    /// Parse a wire byte. Unknown values are a protocol error (§3.3).
    pub fn from_u8(value: u8) -> Result<Self, FrameError> {
        Ok(match value {
            1 => FrameKind::Hello,
            2 => FrameKind::Request,
            3 => FrameKind::Response,
            4 => FrameKind::Event,
            5 => FrameKind::Ack,
            6 => FrameKind::Cancel,
            7 => FrameKind::Drain,
            8 => FrameKind::Error,
            9 => FrameKind::Replay,
            other => return Err(FrameError::UnknownFrameKind(other)),
        })
    }

    /// The wire byte for this kind.
    pub fn as_u8(self) -> u8 {
        self as u8
    }
}

/// Frame-level failures, named after the stable codes in §10.2.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameError {
    /// `magic` is not `CHIP`.
    BadMagic,
    /// `header_len`, reserved bytes, or `flags` are invalid.
    BadHeader,
    /// `payload_length > MAX_FRAME_BYTES`; reject before allocating the body.
    FrameTooLarge,
    /// Reassembled message exceeds `MAX_REASSEMBLED_BYTES` or `MAX_FRAGMENTS`.
    PayloadTooLarge,
    /// The frame is truncated, checksum-failed, or otherwise undecodable.
    DecodeError,
    /// The receive direction skipped a `DURABLE` `transport_sequence` (§7.3).
    ///
    /// Transient gaps are counted by the connection layer and do not surface
    /// here; only a durable discontinuity is fatal to the commit stream.
    SequenceGap {
        /// Sequence the receiver expected next.
        expected: u64,
        /// Sequence actually carried by the frame.
        received: u64,
    },
    /// `frame_kind` is not one of 1..=9.
    UnknownFrameKind(u8),
}

impl FrameError {
    /// Stable §10.2 error code.
    pub fn code(self) -> &'static str {
        match self {
            FrameError::BadMagic => "bad_magic",
            FrameError::BadHeader => "bad_header",
            FrameError::FrameTooLarge => "frame_too_large",
            FrameError::PayloadTooLarge => "payload_too_large",
            FrameError::DecodeError => "decode_error",
            FrameError::SequenceGap { .. } => "sequence_gap",
            FrameError::UnknownFrameKind(_) => "unknown_frame_kind",
        }
    }

    /// §10.2 category.
    pub fn category(self) -> &'static str {
        match self {
            FrameError::UnknownFrameKind(_) | FrameError::SequenceGap { .. } => "protocol",
            _ => "transport",
        }
    }
}

impl core::fmt::Display for FrameError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            FrameError::SequenceGap { expected, received } => write!(
                f,
                "{}: expected sequence {}, received {}",
                self.code(),
                expected,
                received
            ),
            FrameError::UnknownFrameKind(kind) => {
                write!(f, "{}: unknown frame_kind {}", self.code(), kind)
            }
            _ => f.write_str(self.code()),
        }
    }
}

impl std::error::Error for FrameError {}

/// The 64-byte frame header (§3.2).
///
/// `reserved0`/`reserved1` and `header_len` are not stored: they are fixed by
/// the format and rejected on decode when they differ.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Header {
    /// `major << 8 | minor`; see [`PROTOCOL_VERSION_V0`].
    pub protocol_version: u16,
    /// Frame kind (§3.3).
    pub frame_kind: FrameKind,
    /// Flag bits (§3.4).
    pub flags: u16,
    /// Body length in bytes, excluding the header.
    pub payload_length: u32,
    /// Host-assigned connection id; 0 only on the worker's first `hello`.
    pub connection_id: u64,
    /// Host-assigned worker generation; 0 only on `hello`.
    pub worker_generation: u64,
    /// Canonical name: `transport_sequence`. Starts at 1 per direction.
    pub sequence: u64,
    /// UUIDv7 raw bytes; all-zero when the frame is not request-correlated.
    pub correlation_id: [u8; 16],
    /// CRC32C of the body; only meaningful when [`FLAG_CHECKSUM`] is set.
    pub payload_crc32c: u32,
}

impl Header {
    /// Encode this header and `payload` into a complete frame.
    ///
    /// `payload_length` is taken from `payload`. When [`FLAG_CHECKSUM`] is set,
    /// `payload_crc32c` is (re)computed; otherwise the field is written as 0.
    ///
    /// # Panics
    ///
    /// Panics if `payload.len() > MAX_FRAME_BYTES`; callers must split the
    /// message into `MORE` fragments or reject it with `payload_too_large`.
    pub fn encode(&self, payload: &[u8]) -> Vec<u8> {
        assert!(
            payload.len() <= MAX_FRAME_BYTES as usize,
            "payload exceeds MAX_FRAME_BYTES"
        );
        let checksum = if self.flags & FLAG_CHECKSUM != 0 {
            crc32c(payload)
        } else {
            0
        };
        let mut out = Vec::with_capacity(HEADER_LEN as usize + payload.len());
        out.extend_from_slice(&MAGIC.to_le_bytes());
        out.extend_from_slice(&self.protocol_version.to_le_bytes());
        out.extend_from_slice(&HEADER_LEN.to_le_bytes());
        out.push(self.frame_kind.as_u8());
        out.extend_from_slice(&self.flags.to_le_bytes());
        out.push(0); // reserved0
        out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        out.extend_from_slice(&self.connection_id.to_le_bytes());
        out.extend_from_slice(&self.worker_generation.to_le_bytes());
        out.extend_from_slice(&self.sequence.to_le_bytes());
        out.extend_from_slice(&self.correlation_id);
        out.extend_from_slice(&checksum.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes()); // reserved1
        out.extend_from_slice(payload);
        out
    }
}

/// Decode and validate a 64-byte header from the start of `buf`.
///
/// Validation order: magic -> header length -> reserved bytes -> flags ->
/// frame kind -> `payload_length`. The body is never touched or allocated here.
pub fn decode_header(buf: &[u8]) -> Result<Header, FrameError> {
    if buf.len() < 4 {
        return Err(FrameError::DecodeError);
    }
    if u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]) != MAGIC {
        return Err(FrameError::BadMagic);
    }
    if buf.len() < HEADER_LEN as usize {
        return Err(FrameError::DecodeError);
    }
    if u16::from_le_bytes([buf[6], buf[7]]) != HEADER_LEN {
        return Err(FrameError::BadHeader);
    }
    if buf[11] != 0 || u32::from_le_bytes([buf[60], buf[61], buf[62], buf[63]]) != 0 {
        return Err(FrameError::BadHeader);
    }
    let flags = u16::from_le_bytes([buf[9], buf[10]]);
    if flags & !KNOWN_FLAGS != 0 {
        return Err(FrameError::BadHeader);
    }
    let frame_kind = FrameKind::from_u8(buf[8])?;
    let payload_length = u32::from_le_bytes([buf[12], buf[13], buf[14], buf[15]]);
    if payload_length > MAX_FRAME_BYTES {
        return Err(FrameError::FrameTooLarge);
    }
    let mut correlation_id = [0u8; 16];
    correlation_id.copy_from_slice(&buf[40..56]);
    Ok(Header {
        protocol_version: u16::from_le_bytes([buf[4], buf[5]]),
        frame_kind,
        flags,
        payload_length,
        connection_id: u64::from_le_bytes(buf[16..24].try_into().expect("8-byte slice")),
        worker_generation: u64::from_le_bytes(buf[24..32].try_into().expect("8-byte slice")),
        sequence: u64::from_le_bytes(buf[32..40].try_into().expect("8-byte slice")),
        correlation_id,
        payload_crc32c: u32::from_le_bytes([buf[56], buf[57], buf[58], buf[59]]),
    })
}

/// Verify `payload` against the header checksum when [`FLAG_CHECKSUM`] is set.
pub fn verify_checksum(header: &Header, payload: &[u8]) -> Result<(), FrameError> {
    if header.flags & FLAG_CHECKSUM == 0 {
        return Ok(());
    }
    if crc32c(payload) != header.payload_crc32c {
        return Err(FrameError::DecodeError);
    }
    Ok(())
}

/// Bounded reassembly of `MORE` fragments into one logical message (§3.1, §3.5).
///
/// The reassembler enforces `MAX_FRAGMENTS` and `MAX_REASSEMBLED_BYTES` before
/// growing its buffer, and rejects `COMPRESSED` frames unless compression was
/// negotiated for the connection (scenario 18). Checksums are verified per
/// fragment when the `CHECKSUM` flag is set.
#[derive(Debug, Clone)]
pub struct Reassembler {
    buf: Vec<u8>,
    fragments: usize,
    max_fragments: usize,
    max_reassembled_bytes: usize,
    compression_negotiated: bool,
}

impl Default for Reassembler {
    fn default() -> Self {
        Self::new()
    }
}

impl Reassembler {
    /// A reassembler with the v0 candidate defaults.
    pub fn new() -> Self {
        Self::with_limits(MAX_FRAGMENTS, MAX_REASSEMBLED_BYTES)
    }

    /// A reassembler with explicit limits (for negotiated or test values).
    pub fn with_limits(max_fragments: usize, max_reassembled_bytes: usize) -> Self {
        Self {
            buf: Vec::new(),
            fragments: 0,
            max_fragments,
            max_reassembled_bytes,
            compression_negotiated: false,
        }
    }

    /// Record the connection's compression negotiation result.
    pub fn set_compression_negotiated(&mut self, negotiated: bool) {
        self.compression_negotiated = negotiated;
    }

    /// Feed one frame.
    ///
    /// Returns `Ok(None)` while the message is incomplete and
    /// `Ok(Some(body))` when the final (non-`MORE`) fragment completes it.
    /// On error the partial message is discarded.
    pub fn push(&mut self, header: &Header, payload: &[u8]) -> Result<Option<Vec<u8>>, FrameError> {
        if header.flags & FLAG_COMPRESSED != 0 && !self.compression_negotiated {
            self.reset();
            return Err(FrameError::DecodeError);
        }
        if let Err(err) = verify_checksum(header, payload) {
            self.reset();
            return Err(err);
        }
        self.fragments += 1;
        if self.fragments > self.max_fragments {
            self.reset();
            return Err(FrameError::PayloadTooLarge);
        }
        if self.buf.len() + payload.len() > self.max_reassembled_bytes {
            self.reset();
            return Err(FrameError::PayloadTooLarge);
        }
        self.buf.extend_from_slice(payload);
        if header.flags & FLAG_MORE != 0 {
            return Ok(None);
        }
        self.fragments = 0;
        Ok(Some(std::mem::take(&mut self.buf)))
    }

    /// Number of fragments accumulated for the current logical message.
    pub fn fragments(&self) -> usize {
        self.fragments
    }

    fn reset(&mut self) {
        self.buf.clear();
        self.fragments = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const VECTOR_CORRELATION_ID: [u8; 16] = [
        0x01, 0x8f, 0x2a, 0x7c, 0x3d, 0x4e, 0x5f, 0x60, 0x71, 0x82, 0x93, 0xa4, 0xb5, 0xc6, 0xd7,
        0xe8,
    ];

    fn vector_header() -> Header {
        Header {
            protocol_version: PROTOCOL_VERSION_V0,
            frame_kind: FrameKind::Request,
            flags: FLAG_DURABLE,
            payload_length: 123,
            connection_id: 1,
            worker_generation: 7,
            sequence: 1,
            correlation_id: VECTOR_CORRELATION_ID,
            payload_crc32c: 0,
        }
    }

    fn frame(header: Header, payload: &[u8]) -> Vec<u8> {
        header.encode(payload)
    }

    #[test]
    fn header_vector_matches_spec_16_1() {
        const EXPECTED: [u8; 64] = [
            0x43, 0x48, 0x49, 0x50, 0x00, 0x01, 0x40, 0x00, 0x02, 0x02, 0x00, 0x00, 0x7b, 0x00,
            0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x07, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x8f,
            0x2a, 0x7c, 0x3d, 0x4e, 0x5f, 0x60, 0x71, 0x82, 0x93, 0xa4, 0xb5, 0xc6, 0xd7, 0xe8,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        ];
        let payload = vec![0u8; 123];
        let bytes = frame(vector_header(), &payload);
        assert_eq!(&bytes[..HEADER_LEN as usize], &EXPECTED);
        assert_eq!(bytes.len(), HEADER_LEN as usize + 123);

        let decoded = decode_header(&bytes).expect("vector header decodes");
        assert_eq!(decoded, vector_header());
        assert_eq!(decoded.protocol_version, 0x0100);
        assert_eq!(decoded.frame_kind, FrameKind::Request);
        assert_eq!(decoded.flags, FLAG_DURABLE);
        assert_eq!(decoded.payload_length, 123);
        assert_eq!(decoded.connection_id, 1);
        assert_eq!(decoded.worker_generation, 7);
        assert_eq!(decoded.sequence, 1);
    }

    // §16.2 scenario 1. Note: §16.2 says `bad_header` while §10.2 names the
    // stable code `bad_magic`; the more specific §10.2 code is used here.
    #[test]
    fn bad_magic_rejected_before_body() {
        let mut bytes = frame(vector_header(), &[0u8; 8]);
        bytes[0] = 0x00;
        assert_eq!(decode_header(&bytes), Err(FrameError::BadMagic));
    }

    #[test]
    fn truncated_header_is_decode_error() {
        assert_eq!(decode_header(&[]), Err(FrameError::DecodeError));
        assert_eq!(decode_header(&[0x43, 0x48, 0x49, 0x50]), Err(FrameError::DecodeError));
        let bytes = frame(vector_header(), &[]);
        assert_eq!(decode_header(&bytes[..63]), Err(FrameError::DecodeError));
    }

    #[test]
    fn header_len_mismatch_is_bad_header() {
        let mut bytes = frame(vector_header(), &[]);
        bytes[6] = 0x41; // 65
        assert_eq!(decode_header(&bytes), Err(FrameError::BadHeader));
    }

    #[test]
    fn reserved_bytes_must_be_zero() {
        let mut bytes = frame(vector_header(), &[]);
        bytes[11] = 1;
        assert_eq!(decode_header(&bytes), Err(FrameError::BadHeader));

        let mut bytes = frame(vector_header(), &[]);
        bytes[63] = 1;
        assert_eq!(decode_header(&bytes), Err(FrameError::BadHeader));
    }

    #[test]
    fn unknown_flags_are_bad_header() {
        let mut bytes = frame(vector_header(), &[]);
        bytes[10] = 0x80; // bit 15
        assert_eq!(decode_header(&bytes), Err(FrameError::BadHeader));
    }

    // §16.2 scenario 2.
    #[test]
    fn payload_length_over_max_frame_bytes_is_frame_too_large() {
        let mut bytes = frame(vector_header(), &[]);
        bytes[12..16].copy_from_slice(&(MAX_FRAME_BYTES + 1).to_le_bytes());
        assert_eq!(decode_header(&bytes), Err(FrameError::FrameTooLarge));
    }

    // §16.2 scenario 16.
    #[test]
    fn unknown_frame_kind_rejected() {
        let mut bytes = frame(vector_header(), &[]);
        bytes[8] = 10;
        assert_eq!(
            decode_header(&bytes),
            Err(FrameError::UnknownFrameKind(10))
        );
    }

    #[test]
    fn all_frame_kinds_round_trip() {
        for kind in 1..=9u8 {
            let expected = FrameKind::from_u8(kind).expect("defined kind");
            assert_eq!(expected.as_u8(), kind);
            let mut header = vector_header();
            header.frame_kind = expected;
            let decoded = decode_header(&frame(header, b"body")).expect("decodes");
            assert_eq!(decoded.frame_kind, expected);
        }
    }

    #[test]
    fn checksum_is_generated_and_verified() {
        let mut header = vector_header();
        header.flags = FLAG_DURABLE | FLAG_CHECKSUM;
        let payload = b"checksummed payload";
        let bytes = frame(header, payload);
        let decoded = decode_header(&bytes).expect("decodes");
        assert_eq!(decoded.payload_crc32c, crc32c(payload));
        assert!(verify_checksum(&decoded, payload).is_ok());
        assert_eq!(
            verify_checksum(&decoded, b"tampered payload"),
            Err(FrameError::DecodeError)
        );

        // Without the flag the checksum field stays zero and is not verified.
        let plain = vector_header();
        let bytes = frame(plain, payload);
        let decoded = decode_header(&bytes).expect("decodes");
        assert_eq!(decoded.payload_crc32c, 0);
        assert!(verify_checksum(&decoded, b"anything").is_ok());
    }

    // §16.2 scenario 17.
    #[test]
    fn too_many_fragments_is_payload_too_large() {
        let mut reassembler = Reassembler::new();
        let mut header = vector_header();
        header.flags = FLAG_MORE;
        for _ in 0..MAX_FRAGMENTS {
            assert_eq!(reassembler.push(&header, b"x"), Ok(None));
        }
        assert_eq!(reassembler.fragments(), MAX_FRAGMENTS);
        assert_eq!(
            reassembler.push(&header, b"x"),
            Err(FrameError::PayloadTooLarge)
        );
        assert_eq!(reassembler.fragments(), 0, "partial message discarded");
    }

    #[test]
    fn reassembled_bytes_over_limit_is_payload_too_large() {
        let mut reassembler = Reassembler::with_limits(MAX_FRAGMENTS, 8);
        let mut header = vector_header();
        header.flags = FLAG_MORE;
        assert_eq!(reassembler.push(&header, b"1234"), Ok(None));
        assert_eq!(
            reassembler.push(&header, b"56789"),
            Err(FrameError::PayloadTooLarge)
        );
    }

    // §16.2 scenario 18.
    #[test]
    fn compressed_without_negotiation_is_decode_error() {
        let mut header = vector_header();
        header.flags = FLAG_COMPRESSED;
        let mut reassembler = Reassembler::new();
        assert_eq!(
            reassembler.push(&header, b"zstd"),
            Err(FrameError::DecodeError)
        );

        reassembler.set_compression_negotiated(true);
        assert_eq!(
            reassembler.push(&header, b"zstd"),
            Ok(Some(b"zstd".to_vec()))
        );
    }

    #[test]
    fn reassembler_joins_fragments_in_order() {
        let mut reassembler = Reassembler::new();
        let mut header = vector_header();
        header.flags = FLAG_MORE | FLAG_DURABLE;
        assert_eq!(reassembler.push(&header, b"hello "), Ok(None));
        header.sequence += 1;
        header.flags = FLAG_MORE | FLAG_DURABLE | FLAG_FINAL;
        assert_eq!(reassembler.push(&header, b"frag"), Ok(None));
        header.sequence += 1;
        header.flags = FLAG_DURABLE | FLAG_FINAL;
        assert_eq!(
            reassembler.push(&header, b"ments"),
            Ok(Some(b"hello fragments".to_vec()))
        );
        assert_eq!(reassembler.fragments(), 0);
    }

    #[test]
    fn error_codes_match_spec_10_2() {
        assert_eq!(FrameError::BadMagic.code(), "bad_magic");
        assert_eq!(FrameError::BadHeader.code(), "bad_header");
        assert_eq!(FrameError::FrameTooLarge.code(), "frame_too_large");
        assert_eq!(FrameError::PayloadTooLarge.code(), "payload_too_large");
        assert_eq!(FrameError::DecodeError.code(), "decode_error");
        assert_eq!(
            FrameError::UnknownFrameKind(0).code(),
            "unknown_frame_kind"
        );
        assert_eq!(FrameError::BadMagic.category(), "transport");
        assert_eq!(
            FrameError::UnknownFrameKind(0).category(),
            "protocol"
        );
    }

    /// Deterministic xorshift64 so the property test needs no external crate.
    fn next_u64(state: &mut u64) -> u64 {
        let mut x = *state;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        *state = x;
        x
    }

    #[test]
    fn random_frames_encode_decode_identity() {
        let mut state = 0x9E37_79B9_7F4A_7C15u64;
        for _ in 0..256 {
            let len = (next_u64(&mut state) % 4097) as usize;
            let payload: Vec<u8> = (0..len).map(|_| next_u64(&mut state) as u8).collect();
            let mut correlation_id = [0u8; 16];
            for byte in correlation_id.iter_mut() {
                *byte = next_u64(&mut state) as u8;
            }
            let header = Header {
                protocol_version: next_u64(&mut state) as u16,
                frame_kind: FrameKind::from_u8((next_u64(&mut state) % 9 + 1) as u8)
                    .expect("1..=9"),
                flags: (next_u64(&mut state) as u16) & KNOWN_FLAGS,
                payload_length: len as u32,
                connection_id: next_u64(&mut state),
                worker_generation: next_u64(&mut state),
                sequence: next_u64(&mut state),
                correlation_id,
                payload_crc32c: 0,
            };
            let encoded = header.encode(&payload);
            assert_eq!(&encoded[HEADER_LEN as usize..], &payload[..]);

            let decoded = decode_header(&encoded).expect("generated frame decodes");
            let expected_crc = if header.flags & FLAG_CHECKSUM != 0 {
                crc32c(&payload)
            } else {
                0
            };
            assert_eq!(
                decoded,
                Header {
                    payload_crc32c: expected_crc,
                    ..header
                }
            );
        }
    }
}