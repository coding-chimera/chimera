//! Ctx wire (`CTX_ABI_VERSION = 1`).
//!
//! Resolution read-context output buffers. All strings are arena references;
//! node rows are byte-identical to the store's 140-byte row (search_text is
//! always `NONE` on this surface). Layout mirrors
//! `src/graph/resolution/ctx-decode.ts`.

use super::abi::{self, StrRef};
use super::buf::{Reader, Writer, ensure_row_len, reader_at};
use super::error::{CoreError, Result};
use super::store::NodeRow;

/// `CtxNodesOut` header (20 bytes).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NodesHeader {
    pub abi_version: u8,
    pub group_count: u32,
    pub node_count: u32,
    pub arena_len: u32,
}

impl NodesHeader {
    pub const SIZE: usize = abi::CTX_NODES_HEADER_SIZE;

    pub fn encode(&self) -> Vec<u8> {
        let mut writer = Writer::with_capacity(Self::SIZE);
        writer.u8(self.abi_version);
        writer.pad(3);
        writer.u32(self.group_count);
        writer.u32(self.node_count);
        writer.u32(self.arena_len);
        writer.pad(4);
        debug_assert_eq!(writer.len(), Self::SIZE);
        writer.into_vec()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        ensure_row_len(bytes, Self::SIZE, "ctx nodes header")?;
        let mut reader = Reader::new(bytes);
        let header = NodesHeader {
            abi_version: reader.u8()?,
            group_count: {
                reader.skip(3)?;
                reader.u32()?
            },
            node_count: reader.u32()?,
            arena_len: reader.u32()?,
        };
        reader.skip(4)?;
        Ok(header)
    }
}

/// `CtxStringsOut` header (16 bytes).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StringsHeader {
    pub abi_version: u8,
    pub group_count: u32,
    pub str_count: u32,
    pub arena_len: u32,
}

impl StringsHeader {
    pub const SIZE: usize = abi::CTX_STRINGS_HEADER_SIZE;

    pub fn encode(&self) -> Vec<u8> {
        let mut writer = Writer::with_capacity(Self::SIZE);
        writer.u8(self.abi_version);
        writer.pad(3);
        writer.u32(self.group_count);
        writer.u32(self.str_count);
        writer.u32(self.arena_len);
        debug_assert_eq!(writer.len(), Self::SIZE);
        writer.into_vec()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        ensure_row_len(bytes, Self::SIZE, "ctx strings header")?;
        let mut reader = Reader::new(bytes);
        Ok(StringsHeader {
            abi_version: reader.u8()?,
            group_count: {
                reader.skip(3)?;
                reader.u32()?
            },
            str_count: reader.u32()?,
            arena_len: reader.u32()?,
        })
    }
}

/// `CtxImportMappingsOut` header (20 bytes).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MappingsHeader {
    pub abi_version: u8,
    pub group_count: u32,
    pub mapping_count: u32,
    pub arena_len: u32,
}

impl MappingsHeader {
    pub const SIZE: usize = abi::CTX_MAPPINGS_HEADER_SIZE;

    pub fn encode(&self) -> Vec<u8> {
        let mut writer = Writer::with_capacity(Self::SIZE);
        writer.u8(self.abi_version);
        writer.pad(3);
        writer.u32(self.group_count);
        writer.u32(self.mapping_count);
        writer.u32(self.arena_len);
        writer.pad(4);
        debug_assert_eq!(writer.len(), Self::SIZE);
        writer.into_vec()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        ensure_row_len(bytes, Self::SIZE, "ctx mappings header")?;
        let mut reader = Reader::new(bytes);
        let header = MappingsHeader {
            abi_version: reader.u8()?,
            group_count: {
                reader.skip(3)?;
                reader.u32()?
            },
            mapping_count: reader.u32()?,
            arena_len: reader.u32()?,
        };
        reader.skip(4)?;
        Ok(header)
    }
}

/// `CtxReExportsOut` header (20 bytes).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReExportsHeader {
    pub abi_version: u8,
    pub group_count: u32,
    pub reexport_count: u32,
    pub arena_len: u32,
}

impl ReExportsHeader {
    pub const SIZE: usize = abi::CTX_REEXPORTS_HEADER_SIZE;

    pub fn encode(&self) -> Vec<u8> {
        let mut writer = Writer::with_capacity(Self::SIZE);
        writer.u8(self.abi_version);
        writer.pad(3);
        writer.u32(self.group_count);
        writer.u32(self.reexport_count);
        writer.u32(self.arena_len);
        writer.pad(4);
        debug_assert_eq!(writer.len(), Self::SIZE);
        writer.into_vec()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        ensure_row_len(bytes, Self::SIZE, "ctx reexports header")?;
        let mut reader = Reader::new(bytes);
        let header = ReExportsHeader {
            abi_version: reader.u8()?,
            group_count: {
                reader.skip(3)?;
                reader.u32()?
            },
            reexport_count: reader.u32()?,
            arena_len: reader.u32()?,
        };
        reader.skip(4)?;
        Ok(header)
    }
}

/// One group row: `[start, end)` into the accompanying row table (8 bytes).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GroupRow {
    pub start: u32,
    pub end: u32,
}

impl GroupRow {
    pub const SIZE: usize = abi::CTX_GROUP_ROW_SIZE;

    pub fn encode(&self) -> Vec<u8> {
        let mut writer = Writer::with_capacity(Self::SIZE);
        writer.u32(self.start);
        writer.u32(self.end);
        debug_assert_eq!(writer.len(), Self::SIZE);
        writer.into_vec()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        ensure_row_len(bytes, Self::SIZE, "ctx group")?;
        let mut reader = Reader::new(bytes);
        Ok(GroupRow {
            start: reader.u32()?,
            end: reader.u32()?,
        })
    }
}

/// One import-mapping row (36 bytes).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MappingRow {
    pub local_name: StrRef,
    pub exported_name: StrRef,
    pub source: StrRef,
    /// Always `NONE` on this surface: `extractImportMappings` never sets it.
    pub resolved_path: StrRef,
    pub flags: u8,
}

impl MappingRow {
    pub const SIZE: usize = abi::CTX_MAPPING_ROW_SIZE;

    pub fn encode(&self) -> Vec<u8> {
        let mut writer = Writer::with_capacity(Self::SIZE);
        writer.str_ref(self.local_name);
        writer.str_ref(self.exported_name);
        writer.str_ref(self.source);
        writer.str_ref(self.resolved_path);
        writer.u8(self.flags);
        writer.pad(3);
        debug_assert_eq!(writer.len(), Self::SIZE);
        writer.into_vec()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        ensure_row_len(bytes, Self::SIZE, "ctx mapping")?;
        let mut reader = Reader::new(bytes);
        let row = MappingRow {
            local_name: reader.str_ref()?,
            exported_name: reader.str_ref()?,
            source: reader.str_ref()?,
            resolved_path: reader.str_ref()?,
            flags: reader.u8()?,
        };
        reader.skip(3)?;
        Ok(row)
    }
}

/// One re-export row (28 bytes).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReExportRow {
    pub kind: u8,
    pub exported_name: StrRef,
    pub original_name: StrRef,
    pub source: StrRef,
}

impl ReExportRow {
    pub const SIZE: usize = abi::CTX_REEXPORT_ROW_SIZE;

    pub fn encode(&self) -> Vec<u8> {
        let mut writer = Writer::with_capacity(Self::SIZE);
        writer.u8(self.kind);
        writer.pad(3);
        writer.str_ref(self.exported_name);
        writer.str_ref(self.original_name);
        writer.str_ref(self.source);
        debug_assert_eq!(writer.len(), Self::SIZE);
        writer.into_vec()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        ensure_row_len(bytes, Self::SIZE, "ctx reexport")?;
        let mut reader = Reader::new(bytes);
        let kind = reader.u8()?;
        reader.skip(3)?;
        Ok(ReExportRow {
            kind,
            exported_name: reader.str_ref()?,
            original_name: reader.str_ref()?,
            source: reader.str_ref()?,
        })
    }
}

/// Decode one 8-byte string reference row.
pub fn decode_str_row(bytes: &[u8]) -> Result<StrRef> {
    ensure_row_len(bytes, abi::CTX_STR_ROW_SIZE, "ctx str")?;
    let mut reader = Reader::new(bytes);
    reader.str_ref()
}

/// `CtxNodesOut` view over header / groups / nodes / arena.
#[derive(Debug, Clone, Copy)]
pub struct NodesOut<'a> {
    pub header: NodesHeader,
    pub groups: &'a [u8],
    pub nodes: &'a [u8],
    pub arena: &'a [u8],
}

impl<'a> NodesOut<'a> {
    pub fn parse(
        header: &[u8],
        groups: &'a [u8],
        nodes: &'a [u8],
        arena: &'a [u8],
    ) -> Result<Self> {
        let header = NodesHeader::decode(header)?;
        if header.abi_version != abi::CTX_ABI_VERSION {
            return Err(CoreError::wire(format!(
                "ctx wire: abi {} != CTX_ABI_VERSION {}",
                header.abi_version,
                abi::CTX_ABI_VERSION
            )));
        }
        if header.arena_len as usize > arena.len() {
            return Err(CoreError::wire(format!(
                "ctx wire: arena_len {} > arena buffer {}",
                header.arena_len,
                arena.len()
            )));
        }
        check_table(groups, header.group_count, GroupRow::SIZE, "groups")?;
        check_table(nodes, header.node_count, NodeRow::SIZE, "nodes")?;
        Ok(NodesOut {
            header,
            groups,
            nodes,
            arena,
        })
    }

    pub fn group(&self, index: u32) -> Result<GroupRow> {
        let offset = index as usize * GroupRow::SIZE;
        let mut reader = reader_at(self.groups, offset, GroupRow::SIZE, "ctx group")?;
        Ok(GroupRow {
            start: reader.u32()?,
            end: reader.u32()?,
        })
    }

    pub fn node(&self, index: u32) -> Result<NodeRow> {
        NodeRow::decode(row_slice(self.nodes, index, NodeRow::SIZE, "node")?)
    }

    /// Decode every node in group `index`.
    pub fn group_nodes(&self, index: u32) -> Result<Vec<NodeRow>> {
        let group = self.group(index)?;
        (group.start..group.end).map(|row| self.node(row)).collect()
    }
}

/// `CtxStringsOut` view over header / groups / str rows / arena.
#[derive(Debug, Clone, Copy)]
pub struct StringsOut<'a> {
    pub header: StringsHeader,
    pub groups: &'a [u8],
    pub strs: &'a [u8],
    pub arena: &'a [u8],
}

impl<'a> StringsOut<'a> {
    pub fn parse(header: &[u8], groups: &'a [u8], strs: &'a [u8], arena: &'a [u8]) -> Result<Self> {
        let header = StringsHeader::decode(header)?;
        if header.abi_version != abi::CTX_ABI_VERSION {
            return Err(CoreError::wire(format!(
                "ctx wire: abi {} != CTX_ABI_VERSION {}",
                header.abi_version,
                abi::CTX_ABI_VERSION
            )));
        }
        if header.arena_len as usize > arena.len() {
            return Err(CoreError::wire(format!(
                "ctx wire: arena_len {} > arena buffer {}",
                header.arena_len,
                arena.len()
            )));
        }
        check_table(groups, header.group_count, GroupRow::SIZE, "groups")?;
        check_table(strs, header.str_count, abi::CTX_STR_ROW_SIZE, "strs")?;
        Ok(StringsOut {
            header,
            groups,
            strs,
            arena,
        })
    }

    pub fn group(&self, index: u32) -> Result<GroupRow> {
        GroupRow::decode(row_slice(self.groups, index, GroupRow::SIZE, "group")?)
    }

    pub fn str_ref(&self, index: u32) -> Result<StrRef> {
        decode_str_row(row_slice(self.strs, index, abi::CTX_STR_ROW_SIZE, "str")?)
    }

    pub fn group_strings(
        &self,
        index: u32,
        arena: &super::buf::Arena,
    ) -> Result<Vec<Option<String>>> {
        let group = self.group(index)?;
        (group.start..group.end)
            .map(|row| {
                let reference = self.str_ref(row)?;
                Ok(arena.get(reference)?.map(|value| value.to_string()))
            })
            .collect()
    }
}

/// `CtxImportMappingsOut` view over header / groups / mapping rows / arena.
#[derive(Debug, Clone, Copy)]
pub struct MappingsOut<'a> {
    pub header: MappingsHeader,
    pub groups: &'a [u8],
    pub mappings: &'a [u8],
    pub arena: &'a [u8],
}

impl<'a> MappingsOut<'a> {
    pub fn parse(
        header: &[u8],
        groups: &'a [u8],
        mappings: &'a [u8],
        arena: &'a [u8],
    ) -> Result<Self> {
        let header = MappingsHeader::decode(header)?;
        if header.abi_version != abi::CTX_ABI_VERSION {
            return Err(CoreError::wire(format!(
                "ctx wire: abi {} != CTX_ABI_VERSION {}",
                header.abi_version,
                abi::CTX_ABI_VERSION
            )));
        }
        if header.arena_len as usize > arena.len() {
            return Err(CoreError::wire(format!(
                "ctx wire: arena_len {} > arena buffer {}",
                header.arena_len,
                arena.len()
            )));
        }
        check_table(groups, header.group_count, GroupRow::SIZE, "groups")?;
        check_table(mappings, header.mapping_count, MappingRow::SIZE, "mappings")?;
        Ok(MappingsOut {
            header,
            groups,
            mappings,
            arena,
        })
    }

    pub fn group(&self, index: u32) -> Result<GroupRow> {
        GroupRow::decode(row_slice(self.groups, index, GroupRow::SIZE, "group")?)
    }

    pub fn mapping(&self, index: u32) -> Result<MappingRow> {
        MappingRow::decode(row_slice(
            self.mappings,
            index,
            MappingRow::SIZE,
            "mapping",
        )?)
    }
}

/// `CtxReExportsOut` view over header / groups / reexport rows / arena.
#[derive(Debug, Clone, Copy)]
pub struct ReExportsOut<'a> {
    pub header: ReExportsHeader,
    pub groups: &'a [u8],
    pub reexports: &'a [u8],
    pub arena: &'a [u8],
}

impl<'a> ReExportsOut<'a> {
    pub fn parse(
        header: &[u8],
        groups: &'a [u8],
        reexports: &'a [u8],
        arena: &'a [u8],
    ) -> Result<Self> {
        let header = ReExportsHeader::decode(header)?;
        if header.abi_version != abi::CTX_ABI_VERSION {
            return Err(CoreError::wire(format!(
                "ctx wire: abi {} != CTX_ABI_VERSION {}",
                header.abi_version,
                abi::CTX_ABI_VERSION
            )));
        }
        if header.arena_len as usize > arena.len() {
            return Err(CoreError::wire(format!(
                "ctx wire: arena_len {} > arena buffer {}",
                header.arena_len,
                arena.len()
            )));
        }
        check_table(groups, header.group_count, GroupRow::SIZE, "groups")?;
        check_table(
            reexports,
            header.reexport_count,
            ReExportRow::SIZE,
            "reexports",
        )?;
        Ok(ReExportsOut {
            header,
            groups,
            reexports,
            arena,
        })
    }

    pub fn group(&self, index: u32) -> Result<GroupRow> {
        GroupRow::decode(row_slice(self.groups, index, GroupRow::SIZE, "group")?)
    }

    pub fn reexport(&self, index: u32) -> Result<ReExportRow> {
        ReExportRow::decode(row_slice(
            self.reexports,
            index,
            ReExportRow::SIZE,
            "reexport",
        )?)
    }
}

fn row_slice<'a>(buf: &'a [u8], index: u32, row_size: usize, what: &str) -> Result<&'a [u8]> {
    let start = index as usize * row_size;
    let end = start + row_size;
    buf.get(start..end).ok_or_else(|| {
        CoreError::wire(format!(
            "ctx wire: {what} row {index} out of bounds (buffer {}, row size {row_size})",
            buf.len()
        ))
    })
}

fn check_table(buf: &[u8], count: u32, row_size: usize, what: &str) -> Result<()> {
    let required = count as usize * row_size;
    if buf.len() < required {
        return Err(CoreError::wire(format!(
            "ctx wire: {what} buffer {} < {count} rows × {row_size} bytes",
            buf.len()
        )));
    }
    Ok(())
}
