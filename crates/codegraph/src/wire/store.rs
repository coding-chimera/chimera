//! Store wire (`STORE_ABI_VERSION = 1`).
//!
//! Five flat little-endian buffers: `meta`, `nodes`, `edges`, `refs`, `arena`.
//! The meta buffer carries a fixed header followed by the op table and the
//! file table; `nodes`/`edges`/`refs` carry fixed-width rows and the arena
//! holds every string. Layout mirrors `src/graph/store/layout.ts` and
//! `codegraph-kernel/src/store.rs`.

use std::ops::Range;

use super::abi::{self, NONE, StrRef};
use super::buf::{Reader, Writer, ensure_row_len, reader_at};
use super::error::{CoreError, Result};

/// Collapse a wire range end: `NONE` means "same as start".
pub fn collapse_range(start: u32, end: u32) -> Range<u32> {
    let end = if end == NONE { start } else { end };
    start..end.max(start)
}

/// Store meta header (28 bytes). The meta buffer continues with the op and
/// file tables, so decode accepts any buffer of at least 28 bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MetaHeader {
    pub abi_version: u8,
    pub op_count: u32,
    pub file_count: u32,
    pub node_count: u32,
    pub edge_count: u32,
    pub ref_count: u32,
    pub arena_len: u32,
}

impl MetaHeader {
    pub const SIZE: usize = abi::STORE_META_HEADER_SIZE;

    pub fn encode(&self) -> Vec<u8> {
        let mut writer = Writer::with_capacity(Self::SIZE);
        writer.u8(self.abi_version);
        writer.pad(3);
        writer.u32(self.op_count);
        writer.u32(self.file_count);
        writer.u32(self.node_count);
        writer.u32(self.edge_count);
        writer.u32(self.ref_count);
        writer.u32(self.arena_len);
        debug_assert_eq!(writer.len(), Self::SIZE);
        writer.into_vec()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        if bytes.len() < Self::SIZE {
            return Err(CoreError::wire(format!(
                "store wire: meta {} bytes < header {}",
                bytes.len(),
                Self::SIZE
            )));
        }
        let mut reader = Reader::new(&bytes[..Self::SIZE]);
        let header = MetaHeader {
            abi_version: reader.u8()?,
            op_count: {
                reader.skip(3)?;
                reader.u32()?
            },
            file_count: reader.u32()?,
            node_count: reader.u32()?,
            edge_count: reader.u32()?,
            ref_count: reader.u32()?,
            arena_len: reader.u32()?,
        };
        Ok(header)
    }
}

/// Store op row (48 bytes).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OpRow {
    pub code: u8,
    pub file_index: Option<u32>,
    pub node_start: u32,
    pub node_end: u32,
    pub edge_start: u32,
    pub edge_end: u32,
    pub ref_start: u32,
    pub ref_end: u32,
    pub arg: StrRef,
    pub flags: u32,
}

impl OpRow {
    pub const SIZE: usize = abi::STORE_OP_ROW_SIZE;

    pub fn encode(&self) -> Vec<u8> {
        let mut writer = Writer::with_capacity(Self::SIZE);
        writer.u8(self.code);
        writer.pad(3);
        writer.u32(self.file_index.unwrap_or(NONE));
        writer.u32(self.node_start);
        writer.u32(self.node_end);
        writer.u32(self.edge_start);
        writer.u32(self.edge_end);
        writer.u32(self.ref_start);
        writer.u32(self.ref_end);
        writer.str_ref(self.arg);
        writer.u32(self.flags);
        writer.pad(4);
        debug_assert_eq!(writer.len(), Self::SIZE);
        writer.into_vec()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        ensure_row_len(bytes, Self::SIZE, "store op")?;
        let mut reader = Reader::new(bytes);
        let op = decode_op(&mut reader)?;
        Ok(op)
    }

    pub fn node_range(&self) -> Range<u32> {
        collapse_range(self.node_start, self.node_end)
    }

    pub fn edge_range(&self) -> Range<u32> {
        collapse_range(self.edge_start, self.edge_end)
    }

    pub fn ref_range(&self) -> Range<u32> {
        collapse_range(self.ref_start, self.ref_end)
    }
}

/// Store file row (64 bytes).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FileRow {
    pub path: StrRef,
    pub content_hash: StrRef,
    pub language: StrRef,
    pub errors_json: StrRef,
    pub size: i64,
    /// Milliseconds; may be fractional exactly like `stats.mtimeMs`.
    pub modified_at: f64,
    /// Milliseconds since the epoch; supplied by the encoder.
    pub indexed_at: i64,
    pub node_count: u32,
}

impl FileRow {
    pub const SIZE: usize = abi::STORE_FILE_ROW_SIZE;

    pub fn encode(&self) -> Vec<u8> {
        let mut writer = Writer::with_capacity(Self::SIZE);
        writer.str_ref(self.path);
        writer.str_ref(self.content_hash);
        writer.str_ref(self.language);
        writer.str_ref(self.errors_json);
        writer.i64(self.size);
        writer.f64(self.modified_at);
        writer.i64(self.indexed_at);
        writer.u32(self.node_count);
        writer.pad(4);
        debug_assert_eq!(writer.len(), Self::SIZE);
        writer.into_vec()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        ensure_row_len(bytes, Self::SIZE, "store file")?;
        let mut reader = Reader::new(bytes);
        decode_file(&mut reader)
    }
}

/// Store node row (140 bytes).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NodeRow {
    pub id: StrRef,
    pub kind: StrRef,
    pub name: StrRef,
    pub qualified_name: StrRef,
    pub file_path: StrRef,
    pub language: StrRef,
    pub start_line: u32,
    pub end_line: u32,
    pub start_column: u32,
    pub end_column: u32,
    pub docstring: StrRef,
    pub signature: StrRef,
    pub visibility: StrRef,
    pub flags: u8,
    pub decorators_json: StrRef,
    pub type_parameters_json: StrRef,
    pub return_type: StrRef,
    pub params_json: StrRef,
    pub search_text: StrRef,
    pub updated_at: i64,
}

impl NodeRow {
    pub const SIZE: usize = abi::STORE_NODE_ROW_SIZE;

    pub fn encode(&self) -> Vec<u8> {
        let mut writer = Writer::with_capacity(Self::SIZE);
        writer.str_ref(self.id);
        writer.str_ref(self.kind);
        writer.str_ref(self.name);
        writer.str_ref(self.qualified_name);
        writer.str_ref(self.file_path);
        writer.str_ref(self.language);
        writer.u32(self.start_line);
        writer.u32(self.end_line);
        writer.u32(self.start_column);
        writer.u32(self.end_column);
        writer.str_ref(self.docstring);
        writer.str_ref(self.signature);
        writer.str_ref(self.visibility);
        writer.u8(self.flags);
        writer.pad(3);
        writer.str_ref(self.decorators_json);
        writer.str_ref(self.type_parameters_json);
        writer.str_ref(self.return_type);
        writer.str_ref(self.params_json);
        writer.str_ref(self.search_text);
        writer.i64(self.updated_at);
        debug_assert_eq!(writer.len(), Self::SIZE);
        writer.into_vec()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        ensure_row_len(bytes, Self::SIZE, "store node")?;
        let mut reader = Reader::new(bytes);
        decode_node(&mut reader)
    }
}

/// Store edge row (48 bytes).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EdgeRow {
    pub source: StrRef,
    pub target: StrRef,
    pub kind: StrRef,
    pub metadata_json: StrRef,
    /// `NONE` on the wire decodes to `None`.
    pub line: Option<u32>,
    /// `NONE` on the wire decodes to `None`.
    pub col: Option<u32>,
    pub provenance: StrRef,
}

impl EdgeRow {
    pub const SIZE: usize = abi::STORE_EDGE_ROW_SIZE;

    pub fn encode(&self) -> Vec<u8> {
        let mut writer = Writer::with_capacity(Self::SIZE);
        writer.str_ref(self.source);
        writer.str_ref(self.target);
        writer.str_ref(self.kind);
        writer.str_ref(self.metadata_json);
        writer.u32(self.line.unwrap_or(NONE));
        writer.u32(self.col.unwrap_or(NONE));
        writer.str_ref(self.provenance);
        debug_assert_eq!(writer.len(), Self::SIZE);
        writer.into_vec()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        ensure_row_len(bytes, Self::SIZE, "store edge")?;
        let mut reader = Reader::new(bytes);
        decode_edge(&mut reader)
    }
}

/// Store unresolved-ref row (56 bytes).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RefRow {
    pub from_node_id: StrRef,
    pub reference_name: StrRef,
    pub reference_kind: StrRef,
    pub line: Option<u32>,
    pub col: Option<u32>,
    pub candidates_json: StrRef,
    pub file_path: StrRef,
    pub language: StrRef,
}

impl RefRow {
    pub const SIZE: usize = abi::STORE_REF_ROW_SIZE;

    pub fn encode(&self) -> Vec<u8> {
        let mut writer = Writer::with_capacity(Self::SIZE);
        writer.str_ref(self.from_node_id);
        writer.str_ref(self.reference_name);
        writer.str_ref(self.reference_kind);
        writer.u32(self.line.unwrap_or(NONE));
        writer.u32(self.col.unwrap_or(NONE));
        writer.str_ref(self.candidates_json);
        writer.str_ref(self.file_path);
        writer.str_ref(self.language);
        debug_assert_eq!(writer.len(), Self::SIZE);
        writer.into_vec()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        ensure_row_len(bytes, Self::SIZE, "store ref")?;
        let mut reader = Reader::new(bytes);
        decode_ref(&mut reader)
    }
}

/// Borrowed store buffers — the decode view over one batch.
#[derive(Debug, Clone, Copy)]
pub struct Buffers<'a> {
    pub meta: &'a [u8],
    pub nodes: &'a [u8],
    pub edges: &'a [u8],
    pub refs: &'a [u8],
    pub arena: &'a [u8],
}

impl<'a> Buffers<'a> {
    pub fn header(&self) -> Result<MetaHeader> {
        MetaHeader::decode(self.meta)
    }

    /// Verify the ABI, the op/file table extent, and every row buffer length.
    pub fn validate(&self) -> Result<MetaHeader> {
        let header = self.header()?;
        if header.abi_version != abi::STORE_ABI_VERSION {
            return Err(CoreError::wire(format!(
                "store wire: abi {} != STORE_ABI_VERSION {}",
                header.abi_version,
                abi::STORE_ABI_VERSION
            )));
        }
        if header.arena_len as usize > self.arena.len() {
            return Err(CoreError::wire(format!(
                "store wire: meta arena_len {} > arena buffer {}",
                header.arena_len,
                self.arena.len()
            )));
        }
        let required =
            header.op_count as usize * OpRow::SIZE + header.file_count as usize * FileRow::SIZE;
        let available = self.meta.len().saturating_sub(MetaHeader::SIZE);
        if available < required {
            return Err(CoreError::wire(format!(
                "store wire: meta {} bytes < op/file tables end {}",
                self.meta.len(),
                MetaHeader::SIZE + required
            )));
        }
        check_table(self.nodes, header.node_count, NodeRow::SIZE, "nodes")?;
        check_table(self.edges, header.edge_count, EdgeRow::SIZE, "edges")?;
        check_table(self.refs, header.ref_count, RefRow::SIZE, "refs")?;
        Ok(header)
    }

    pub fn op(&self, index: u32) -> Result<OpRow> {
        let offset = MetaHeader::SIZE + index as usize * OpRow::SIZE;
        let mut reader = reader_at(self.meta, offset, OpRow::SIZE, "store op")?;
        decode_op(&mut reader)
    }

    pub fn file(&self, index: u32) -> Result<FileRow> {
        let header = self.header()?;
        let offset = MetaHeader::SIZE
            + header.op_count as usize * OpRow::SIZE
            + index as usize * FileRow::SIZE;
        let mut reader = reader_at(self.meta, offset, FileRow::SIZE, "store file")?;
        decode_file(&mut reader)
    }

    pub fn node(&self, index: u32) -> Result<NodeRow> {
        let mut reader = reader_at(
            self.nodes,
            index as usize * NodeRow::SIZE,
            NodeRow::SIZE,
            "store node",
        )?;
        decode_node(&mut reader)
    }

    pub fn edge(&self, index: u32) -> Result<EdgeRow> {
        let mut reader = reader_at(
            self.edges,
            index as usize * EdgeRow::SIZE,
            EdgeRow::SIZE,
            "store edge",
        )?;
        decode_edge(&mut reader)
    }

    pub fn reference(&self, index: u32) -> Result<RefRow> {
        let mut reader = reader_at(
            self.refs,
            index as usize * RefRow::SIZE,
            RefRow::SIZE,
            "store ref",
        )?;
        decode_ref(&mut reader)
    }

    pub fn ops(&self) -> Result<Vec<OpRow>> {
        let header = self.header()?;
        (0..header.op_count).map(|index| self.op(index)).collect()
    }

    pub fn files(&self) -> Result<Vec<FileRow>> {
        let header = self.header()?;
        (0..header.file_count)
            .map(|index| self.file(index))
            .collect()
    }
}

fn check_table(buf: &[u8], count: u32, row_size: usize, what: &str) -> Result<()> {
    let required = count as usize * row_size;
    if buf.len() < required {
        return Err(CoreError::wire(format!(
            "store wire: {what} buffer {} < {count} rows × {row_size} bytes",
            buf.len()
        )));
    }
    Ok(())
}

fn decode_op(reader: &mut Reader<'_>) -> Result<OpRow> {
    let code = reader.u8()?;
    reader.skip(3)?;
    let file_index = reader.u32()?;
    let op = OpRow {
        code,
        file_index: if file_index == NONE {
            None
        } else {
            Some(file_index)
        },
        node_start: reader.u32()?,
        node_end: reader.u32()?,
        edge_start: reader.u32()?,
        edge_end: reader.u32()?,
        ref_start: reader.u32()?,
        ref_end: reader.u32()?,
        arg: reader.str_ref()?,
        flags: reader.u32()?,
    };
    reader.skip(4)?;
    Ok(op)
}

fn decode_file(reader: &mut Reader<'_>) -> Result<FileRow> {
    let row = FileRow {
        path: reader.str_ref()?,
        content_hash: reader.str_ref()?,
        language: reader.str_ref()?,
        errors_json: reader.str_ref()?,
        size: reader.i64()?,
        modified_at: reader.f64()?,
        indexed_at: reader.i64()?,
        node_count: reader.u32()?,
    };
    reader.skip(4)?;
    Ok(row)
}

fn decode_node(reader: &mut Reader<'_>) -> Result<NodeRow> {
    Ok(NodeRow {
        id: reader.str_ref()?,
        kind: reader.str_ref()?,
        name: reader.str_ref()?,
        qualified_name: reader.str_ref()?,
        file_path: reader.str_ref()?,
        language: reader.str_ref()?,
        start_line: reader.u32()?,
        end_line: reader.u32()?,
        start_column: reader.u32()?,
        end_column: reader.u32()?,
        docstring: reader.str_ref()?,
        signature: reader.str_ref()?,
        visibility: reader.str_ref()?,
        flags: reader.u8()?,
        decorators_json: {
            reader.skip(3)?;
            reader.str_ref()?
        },
        type_parameters_json: reader.str_ref()?,
        return_type: reader.str_ref()?,
        params_json: reader.str_ref()?,
        search_text: reader.str_ref()?,
        updated_at: reader.i64()?,
    })
}

fn decode_edge(reader: &mut Reader<'_>) -> Result<EdgeRow> {
    let source = reader.str_ref()?;
    let target = reader.str_ref()?;
    let kind = reader.str_ref()?;
    let metadata_json = reader.str_ref()?;
    let line = reader.u32()?;
    let col = reader.u32()?;
    Ok(EdgeRow {
        source,
        target,
        kind,
        metadata_json,
        line: if line == NONE { None } else { Some(line) },
        col: if col == NONE { None } else { Some(col) },
        provenance: reader.str_ref()?,
    })
}

fn decode_ref(reader: &mut Reader<'_>) -> Result<RefRow> {
    let from_node_id = reader.str_ref()?;
    let reference_name = reader.str_ref()?;
    let reference_kind = reader.str_ref()?;
    let line = reader.u32()?;
    let col = reader.u32()?;
    Ok(RefRow {
        from_node_id,
        reference_name,
        reference_kind,
        line: if line == NONE { None } else { Some(line) },
        col: if col == NONE { None } else { Some(col) },
        candidates_json: reader.str_ref()?,
        file_path: reader.str_ref()?,
        language: reader.str_ref()?,
    })
}
