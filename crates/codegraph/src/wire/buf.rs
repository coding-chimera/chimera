//! Byte-level primitives for every wire layout: the UTF-8 string arena, a
//! little-endian writer, and a bounds-checked reader.
//!
//! All wire rows are fixed-width; variable-length strings live in the arena as
//! `(offset u32, len u32)` pairs. `NONE` (`0xFFFF_FFFF`) marks an absent field.
//! Readers never panic on truncated input — they return
//! [`CoreErrorCode::Wire`](super::error::CoreErrorCode::Wire).

use super::abi::{NONE, StrRef};
use super::error::{CoreError, Result};

// ---------------------------------------------------------------------------
// Arena
// ---------------------------------------------------------------------------

/// Append-only UTF-8 string arena. No alignment and no dedup requirement.
#[derive(Debug, Default, Clone)]
pub struct Arena {
    buf: Vec<u8>,
}

impl Arena {
    pub fn new() -> Self {
        Arena::default()
    }

    /// Rebuild an arena from raw wire bytes (decode-side views).
    pub fn from_bytes(bytes: &[u8]) -> Self {
        Arena {
            buf: bytes.to_vec(),
        }
    }

    /// Append `value` and return its reference.
    pub fn put(&mut self, value: &str) -> StrRef {
        let offset = self.buf.len() as u32;
        self.buf.extend_from_slice(value.as_bytes());
        (offset, value.len() as u32)
    }

    /// Append an optional string; `None` encodes as [`NONE_STR`](super::abi::NONE_STR).
    pub fn put_opt(&mut self, value: Option<&str>) -> StrRef {
        match value {
            Some(value) => self.put(value),
            None => super::abi::NONE_STR,
        }
    }

    /// Append a NUL-joined list; an empty list encodes as absent.
    pub fn put_list(&mut self, items: &[String]) -> StrRef {
        if items.is_empty() {
            return super::abi::NONE_STR;
        }
        self.put(&items.join("\0"))
    }

    /// Resolve a reference. `NONE` → `None`; out-of-bounds or non-UTF-8 refs
    /// are hard wire errors.
    pub fn get(&self, reference: StrRef) -> Result<Option<&str>> {
        let (offset, len) = reference;
        if offset == NONE {
            return Ok(None);
        }
        let start = offset as usize;
        let end = start
            .checked_add(len as usize)
            .ok_or_else(|| CoreError::wire(format!("wire: arena ref {offset}+{len} overflows")))?;
        let bytes = self.buf.get(start..end).ok_or_else(|| {
            CoreError::wire(format!(
                "wire: arena ref {offset}+{len} out of bounds (arena {})",
                self.buf.len()
            ))
        })?;
        let text = std::str::from_utf8(bytes)
            .map_err(|_| CoreError::wire(format!("wire: arena ref {offset}+{len} is not UTF-8")))?;
        Ok(Some(text))
    }

    /// Resolve a reference that must be present.
    pub fn require(&self, reference: StrRef) -> Result<&str> {
        self.get(reference)?
            .ok_or_else(|| CoreError::wire("wire: required string slot is NONE"))
    }

    pub fn len(&self) -> u32 {
        self.buf.len() as u32
    }

    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }

    pub fn as_bytes(&self) -> &[u8] {
        &self.buf
    }

    pub fn into_vec(self) -> Vec<u8> {
        self.buf
    }
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/// Little-endian byte writer. Rows are built by writing fields in wire order.
#[derive(Debug, Default, Clone)]
pub struct Writer {
    buf: Vec<u8>,
}

impl Writer {
    pub fn new() -> Self {
        Writer::default()
    }

    pub fn with_capacity(capacity: usize) -> Self {
        Writer {
            buf: Vec::with_capacity(capacity),
        }
    }

    pub fn u8(&mut self, value: u8) {
        self.buf.push(value);
    }

    pub fn u16(&mut self, value: u16) {
        self.buf.extend_from_slice(&value.to_le_bytes());
    }

    pub fn u32(&mut self, value: u32) {
        self.buf.extend_from_slice(&value.to_le_bytes());
    }

    pub fn i64(&mut self, value: i64) {
        self.buf.extend_from_slice(&value.to_le_bytes());
    }

    pub fn f64(&mut self, value: f64) {
        self.buf.extend_from_slice(&value.to_le_bytes());
    }

    pub fn str_ref(&mut self, reference: StrRef) {
        self.u32(reference.0);
        self.u32(reference.1);
    }

    /// Write `count` zero bytes.
    pub fn pad(&mut self, count: usize) {
        self.buf.resize(self.buf.len() + count, 0);
    }

    pub fn extend(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
    }

    pub fn len(&self) -> usize {
        self.buf.len()
    }

    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }

    pub fn as_slice(&self) -> &[u8] {
        &self.buf
    }

    pub fn into_vec(self) -> Vec<u8> {
        self.buf
    }
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

/// Bounds-checked little-endian reader.
#[derive(Debug, Clone)]
pub struct Reader<'a> {
    buf: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    pub fn new(buf: &'a [u8]) -> Self {
        Reader { buf, at: 0 }
    }

    pub fn position(&self) -> usize {
        self.at
    }

    pub fn remaining(&self) -> usize {
        self.buf.len().saturating_sub(self.at)
    }

    pub fn is_empty(&self) -> bool {
        self.remaining() == 0
    }

    pub fn u8(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }

    pub fn u16(&mut self) -> Result<u16> {
        let bytes = self.take(2)?;
        Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
    }

    pub fn u32(&mut self) -> Result<u32> {
        let bytes = self.take(4)?;
        Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }

    pub fn i64(&mut self) -> Result<i64> {
        let bytes = self.take(8)?;
        Ok(i64::from_le_bytes([
            bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
        ]))
    }

    pub fn f64(&mut self) -> Result<f64> {
        let bytes = self.take(8)?;
        Ok(f64::from_le_bytes([
            bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
        ]))
    }

    pub fn str_ref(&mut self) -> Result<StrRef> {
        let offset = self.u32()?;
        let len = self.u32()?;
        Ok((offset, len))
    }

    pub fn skip(&mut self, count: usize) -> Result<()> {
        self.take(count).map(|_| ())
    }

    /// Consume `count` bytes or fail with a wire error naming the offset.
    pub fn take(&mut self, count: usize) -> Result<&'a [u8]> {
        let end = self.at.checked_add(count).ok_or_else(|| {
            CoreError::wire(format!(
                "wire: read of {count} bytes at {} overflows",
                self.at
            ))
        })?;
        let slice = self.buf.get(self.at..end).ok_or_else(|| {
            CoreError::wire(format!(
                "wire: read of {count} bytes at {} out of bounds (buffer {})",
                self.at,
                self.buf.len()
            ))
        })?;
        self.at = end;
        Ok(slice)
    }
}

// ---------------------------------------------------------------------------
// Row helpers
// ---------------------------------------------------------------------------

/// Assert a single encoded row has exactly `expected` bytes.
pub fn ensure_row_len(buf: &[u8], expected: usize, what: &str) -> Result<()> {
    if buf.len() == expected {
        return Ok(());
    }
    Err(CoreError::wire(format!(
        "wire: {what} row is {} bytes, expected {expected}",
        buf.len()
    )))
}

/// Row count of a fixed-width table buffer; a non-multiple length is a wire
/// error.
pub fn row_count(buf: &[u8], row_size: usize, what: &str) -> Result<u32> {
    if row_size == 0 {
        return Err(CoreError::wire(format!("wire: {what} row size is zero")));
    }
    if buf.len() % row_size != 0 {
        return Err(CoreError::wire(format!(
            "wire: {what} buffer {} bytes is not a multiple of row size {row_size}",
            buf.len()
        )));
    }
    Ok((buf.len() / row_size) as u32)
}

/// Decode a table buffer row by row with `decode`.
pub fn decode_rows<T>(
    buf: &[u8],
    row_size: usize,
    what: &str,
    mut decode: impl FnMut(&mut Reader<'_>) -> Result<T>,
) -> Result<Vec<T>> {
    let count = row_count(buf, row_size, what)? as usize;
    let mut rows = Vec::with_capacity(count);
    for index in 0..count {
        let start = index * row_size;
        let mut reader = Reader::new(&buf[start..start + row_size]);
        rows.push(decode(&mut reader)?);
    }
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arena_round_trips_optional_and_list_strings() {
        let mut arena = Arena::new();
        let present = arena.put("hello");
        let absent = arena.put_opt(None);
        let list = arena.put_list(&["a".to_string(), "b".to_string()]);
        assert_eq!(arena.get(present).unwrap(), Some("hello"));
        assert_eq!(arena.get(absent).unwrap(), None);
        assert_eq!(arena.get(list).unwrap(), Some("a\0b"));
    }

    #[test]
    fn reader_reports_truncation_instead_of_panicking() {
        let mut reader = Reader::new(&[1, 2, 3]);
        assert!(reader.u32().is_err());
        assert_eq!(reader.position(), 0);
    }

    #[test]
    fn row_count_rejects_partial_rows() {
        assert_eq!(row_count(&[0u8; 8], 4, "x").unwrap(), 2);
        assert!(row_count(&[0u8; 7], 4, "x").is_err());
    }
}

/// Open a reader over row `index` of a fixed-width table buffer.
pub fn row_reader<'a>(
    buf: &'a [u8],
    index: u32,
    row_size: usize,
    what: &str,
) -> Result<Reader<'a>> {
    let offset = (index as usize)
        .checked_mul(row_size)
        .ok_or_else(|| CoreError::wire(format!("wire: {what} row {index} offset overflows")))?;
    reader_at(buf, offset, row_size, what)
}

/// Open a reader over a fixed-width row at a byte `offset`.
pub fn reader_at<'a>(
    buf: &'a [u8],
    offset: usize,
    row_size: usize,
    what: &str,
) -> Result<Reader<'a>> {
    let end = offset
        .checked_add(row_size)
        .ok_or_else(|| CoreError::wire(format!("wire: {what} at {offset} overflows")))?;
    let slice = buf.get(offset..end).ok_or_else(|| {
        CoreError::wire(format!(
            "wire: {what} at {offset} out of bounds (buffer {}, row size {row_size})",
            buf.len()
        ))
    })?;
    Ok(Reader::new(slice))
}
