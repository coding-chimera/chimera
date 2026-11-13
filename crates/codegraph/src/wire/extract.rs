//! Extraction wire (`KERNEL_ABI_VERSION = 2`).
//!
//! Five flat little-endian buffers: `meta`, `nodes`, `edges`, `refs`, `arena`.
//! Every string is an `(offset, len)` pair into the UTF-8 arena; `NONE` marks
//! an absent field. Row order and field order are the TS encoder contract
//! (`src/extraction/kernel/layout.ts`).

use super::abi::{self, StrRef};
use super::buf::{Reader, Writer, ensure_row_len, row_reader};
use super::error::{CoreError, Result};

/// Extraction meta buffer.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Meta {
    pub abi_version: u8,
    pub node_count: u32,
    pub edge_count: u32,
    pub ref_count: u32,
    pub arena_len: u32,
    /// Errors-JSON arena reference; `NONE` means no errors.
    pub errors_json: StrRef,
    /// Kernel-side wall duration in milliseconds — introspection only.
    pub duration_ms: f64,
}

impl Meta {
    pub const SIZE: usize = abi::META_SIZE;

    pub fn encode(&self) -> Vec<u8> {
        let mut writer = Writer::with_capacity(Self::SIZE);
        writer.u8(self.abi_version);
        writer.pad(3);
        writer.u32(self.node_count);
        writer.u32(self.edge_count);
        writer.u32(self.ref_count);
        writer.u32(self.arena_len);
        writer.str_ref(self.errors_json);
        writer.f64(self.duration_ms);
        debug_assert_eq!(writer.len(), Self::SIZE);
        writer.into_vec()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        ensure_row_len(bytes, Self::SIZE, "extract meta")?;
        let mut reader = Reader::new(bytes);
        Ok(Meta {
            abi_version: reader.u8()?,
            node_count: {
                reader.skip(3)?;
                reader.u32()?
            },
            edge_count: reader.u32()?,
            ref_count: reader.u32()?,
            arena_len: reader.u32()?,
            errors_json: reader.str_ref()?,
            duration_ms: reader.f64()?,
        })
    }
}

/// Extraction node row (96 bytes).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NodeRow {
    pub kind: u8,
    pub visibility: u8,
    pub flags: u16,
    pub start_line: u32,
    pub end_line: u32,
    pub start_column: u32,
    pub end_column: u32,
    pub name: StrRef,
    pub qualified_name: StrRef,
    pub id: StrRef,
    pub docstring: StrRef,
    pub signature: StrRef,
    pub decorators: StrRef,
    pub type_parameters: StrRef,
    pub return_type: StrRef,
    pub extra_json: StrRef,
    pub metrics: u32,
}

impl NodeRow {
    pub const SIZE: usize = abi::NODE_ROW_SIZE;

    pub fn encode(&self) -> Vec<u8> {
        let mut writer = Writer::with_capacity(Self::SIZE);
        writer.u8(self.kind);
        writer.u8(self.visibility);
        writer.u16(self.flags);
        writer.u32(self.start_line);
        writer.u32(self.end_line);
        writer.u32(self.start_column);
        writer.u32(self.end_column);
        writer.str_ref(self.name);
        writer.str_ref(self.qualified_name);
        writer.str_ref(self.id);
        writer.str_ref(self.docstring);
        writer.str_ref(self.signature);
        writer.str_ref(self.decorators);
        writer.str_ref(self.type_parameters);
        writer.str_ref(self.return_type);
        writer.str_ref(self.extra_json);
        writer.u32(self.metrics);
        debug_assert_eq!(writer.len(), Self::SIZE);
        writer.into_vec()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        ensure_row_len(bytes, Self::SIZE, "extract node")?;
        let mut reader = Reader::new(bytes);
        Ok(NodeRow {
            kind: reader.u8()?,
            visibility: reader.u8()?,
            flags: reader.u16()?,
            start_line: reader.u32()?,
            end_line: reader.u32()?,
            start_column: reader.u32()?,
            end_column: reader.u32()?,
            name: reader.str_ref()?,
            qualified_name: reader.str_ref()?,
            id: reader.str_ref()?,
            docstring: reader.str_ref()?,
            signature: reader.str_ref()?,
            decorators: reader.str_ref()?,
            type_parameters: reader.str_ref()?,
            return_type: reader.str_ref()?,
            extra_json: reader.str_ref()?,
            metrics: reader.u32()?,
        })
    }
}

/// Extraction edge row (44 bytes).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EdgeRow {
    /// Source node row index; `NONE` means use `source_id`.
    pub source: u32,
    /// Target node row index; `NONE` means use `target_id`.
    pub target: u32,
    pub kind: u8,
    pub provenance: u8,
    pub line: u32,
    pub column: u32,
    pub metadata_json: StrRef,
    pub source_id: StrRef,
    pub target_id: StrRef,
}

impl EdgeRow {
    pub const SIZE: usize = abi::EDGE_ROW_SIZE;

    pub fn encode(&self) -> Vec<u8> {
        let mut writer = Writer::with_capacity(Self::SIZE);
        writer.u32(self.source);
        writer.u32(self.target);
        writer.u8(self.kind);
        writer.u8(self.provenance);
        writer.pad(2);
        writer.u32(self.line);
        writer.u32(self.column);
        writer.str_ref(self.metadata_json);
        writer.str_ref(self.source_id);
        writer.str_ref(self.target_id);
        debug_assert_eq!(writer.len(), Self::SIZE);
        writer.into_vec()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        ensure_row_len(bytes, Self::SIZE, "extract edge")?;
        let mut reader = Reader::new(bytes);
        let source = reader.u32()?;
        let target = reader.u32()?;
        let kind = reader.u8()?;
        let provenance = reader.u8()?;
        reader.skip(2)?;
        Ok(EdgeRow {
            source,
            target,
            kind,
            provenance,
            line: reader.u32()?,
            column: reader.u32()?,
            metadata_json: reader.str_ref()?,
            source_id: reader.str_ref()?,
            target_id: reader.str_ref()?,
        })
    }
}

/// Extraction unresolved-ref row (40 bytes).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RefRow {
    pub from_node: u32,
    pub kind: u8,
    pub flags: u8,
    pub line: u32,
    pub column: u32,
    pub reference_name: StrRef,
    pub candidates: StrRef,
    pub from_node_id: StrRef,
}

impl RefRow {
    pub const SIZE: usize = abi::REF_ROW_SIZE;

    pub fn encode(&self) -> Vec<u8> {
        let mut writer = Writer::with_capacity(Self::SIZE);
        writer.u32(self.from_node);
        writer.u8(self.kind);
        writer.u8(self.flags);
        writer.pad(2);
        writer.u32(self.line);
        writer.u32(self.column);
        writer.str_ref(self.reference_name);
        writer.str_ref(self.candidates);
        writer.str_ref(self.from_node_id);
        debug_assert_eq!(writer.len(), Self::SIZE);
        writer.into_vec()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        ensure_row_len(bytes, Self::SIZE, "extract ref")?;
        let mut reader = Reader::new(bytes);
        let from_node = reader.u32()?;
        let kind = reader.u8()?;
        let flags = reader.u8()?;
        reader.skip(2)?;
        Ok(RefRow {
            from_node,
            kind,
            flags,
            line: reader.u32()?,
            column: reader.u32()?,
            reference_name: reader.str_ref()?,
            candidates: reader.str_ref()?,
            from_node_id: reader.str_ref()?,
        })
    }
}

/// Owned extraction buffers, mirroring the adapter's output object.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Buffers {
    pub meta: Vec<u8>,
    pub nodes: Vec<u8>,
    pub edges: Vec<u8>,
    pub refs: Vec<u8>,
    pub arena: Vec<u8>,
}

impl Buffers {
    pub fn as_raw(&self) -> RawBufs<'_> {
        RawBufs {
            meta: &self.meta,
            nodes: &self.nodes,
            edges: &self.edges,
            refs: &self.refs,
            arena: &self.arena,
        }
    }
}

/// Borrowed extraction buffers — the zero-copy decode view.
#[derive(Debug, Clone, Copy)]
pub struct RawBufs<'a> {
    pub meta: &'a [u8],
    pub nodes: &'a [u8],
    pub edges: &'a [u8],
    pub refs: &'a [u8],
    pub arena: &'a [u8],
}

impl<'a> RawBufs<'a> {
    pub fn meta(&self) -> Result<Meta> {
        Meta::decode(self.meta)
    }

    pub fn node(&self, index: u32) -> Result<NodeRow> {
        let mut reader = row_reader(self.nodes, index, NodeRow::SIZE, "extract node")?;
        decode_node(&mut reader)
    }

    pub fn edge(&self, index: u32) -> Result<EdgeRow> {
        let mut reader = row_reader(self.edges, index, EdgeRow::SIZE, "extract edge")?;
        decode_edge(&mut reader)
    }

    pub fn reference(&self, index: u32) -> Result<RefRow> {
        let mut reader = row_reader(self.refs, index, RefRow::SIZE, "extract ref")?;
        decode_ref(&mut reader)
    }

    /// Verify the ABI and that every declared count fits its buffer.
    pub fn validate(&self) -> Result<Meta> {
        let meta = self.meta()?;
        if meta.abi_version != abi::KERNEL_ABI_VERSION {
            return Err(CoreError::wire(format!(
                "extract wire: abi {} != KERNEL_ABI_VERSION {}",
                meta.abi_version,
                abi::KERNEL_ABI_VERSION
            )));
        }
        if meta.arena_len as usize > self.arena.len() {
            return Err(CoreError::wire(format!(
                "extract wire: meta arena_len {} > arena buffer {}",
                meta.arena_len,
                self.arena.len()
            )));
        }
        check_table(self.nodes, meta.node_count, NodeRow::SIZE, "nodes")?;
        check_table(self.edges, meta.edge_count, EdgeRow::SIZE, "edges")?;
        check_table(self.refs, meta.ref_count, RefRow::SIZE, "refs")?;
        Ok(meta)
    }
}

fn check_table(buf: &[u8], count: u32, row_size: usize, what: &str) -> Result<()> {
    let required = count as usize * row_size;
    if buf.len() < required {
        return Err(CoreError::wire(format!(
            "extract wire: {what} buffer {} < {count} rows × {row_size} bytes",
            buf.len()
        )));
    }
    Ok(())
}

fn decode_node(reader: &mut Reader<'_>) -> Result<NodeRow> {
    Ok(NodeRow {
        kind: reader.u8()?,
        visibility: reader.u8()?,
        flags: reader.u16()?,
        start_line: reader.u32()?,
        end_line: reader.u32()?,
        start_column: reader.u32()?,
        end_column: reader.u32()?,
        name: reader.str_ref()?,
        qualified_name: reader.str_ref()?,
        id: reader.str_ref()?,
        docstring: reader.str_ref()?,
        signature: reader.str_ref()?,
        decorators: reader.str_ref()?,
        type_parameters: reader.str_ref()?,
        return_type: reader.str_ref()?,
        extra_json: reader.str_ref()?,
        metrics: reader.u32()?,
    })
}

fn decode_edge(reader: &mut Reader<'_>) -> Result<EdgeRow> {
    let source = reader.u32()?;
    let target = reader.u32()?;
    let kind = reader.u8()?;
    let provenance = reader.u8()?;
    reader.skip(2)?;
    Ok(EdgeRow {
        source,
        target,
        kind,
        provenance,
        line: reader.u32()?,
        column: reader.u32()?,
        metadata_json: reader.str_ref()?,
        source_id: reader.str_ref()?,
        target_id: reader.str_ref()?,
    })
}

fn decode_ref(reader: &mut Reader<'_>) -> Result<RefRow> {
    let from_node = reader.u32()?;
    let kind = reader.u8()?;
    let flags = reader.u8()?;
    reader.skip(2)?;
    Ok(RefRow {
        from_node,
        kind,
        flags,
        line: reader.u32()?,
        column: reader.u32()?,
        reference_name: reader.str_ref()?,
        candidates: reader.str_ref()?,
        from_node_id: reader.str_ref()?,
    })
}
