//! Resolve wire (`RESOLVE_ABI_VERSION = 1`).
//!
//! Resolution batch input/output buffers. Input carries the ref batch plus the
//! precomputed external strategy tables; output carries the persist plan
//! (edges, refs, file sweeps, stats, arena). Layout mirrors
//! `src/graph/resolution/resolve-encode.ts` and `codegraph-kernel/src/resolver.rs`.

use super::abi::{self, StrRef};
use super::buf::{Reader, Writer, ensure_row_len, reader_at};
use super::error::{CoreError, Result};

/// Resolve input meta (16 bytes).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Meta {
    pub abi_version: u8,
    pub ref_count: u32,
    /// Bit 0: sweep the batch's own files for file-level import edges.
    pub flags: u32,
    pub arena_len: u32,
}

impl Meta {
    pub const SIZE: usize = abi::RESOLVE_META_SIZE;

    pub fn encode(&self) -> Vec<u8> {
        let mut writer = Writer::with_capacity(Self::SIZE);
        writer.u8(self.abi_version);
        writer.pad(3);
        writer.u32(self.ref_count);
        writer.u32(self.flags);
        writer.u32(self.arena_len);
        debug_assert_eq!(writer.len(), Self::SIZE);
        writer.into_vec()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        ensure_row_len(bytes, Self::SIZE, "resolve meta")?;
        let mut reader = Reader::new(bytes);
        let meta = Meta {
            abi_version: reader.u8()?,
            ref_count: {
                reader.skip(3)?;
                reader.u32()?
            },
            flags: reader.u32()?,
            arena_len: reader.u32()?,
        };
        Ok(meta)
    }
}

/// Resolve input ref row (64 bytes).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RefRow {
    /// Row id; `-1` means absent.
    pub id: i64,
    pub from_node_id: StrRef,
    pub reference_name: StrRef,
    pub reference_kind: StrRef,
    pub file_path: StrRef,
    pub language: StrRef,
    pub line: i64,
    pub column: i64,
}

impl RefRow {
    pub const SIZE: usize = abi::RESOLVE_REF_ROW_SIZE;

    pub fn encode(&self) -> Vec<u8> {
        let mut writer = Writer::with_capacity(Self::SIZE);
        writer.i64(self.id);
        writer.str_ref(self.from_node_id);
        writer.str_ref(self.reference_name);
        writer.str_ref(self.reference_kind);
        writer.str_ref(self.file_path);
        writer.str_ref(self.language);
        writer.i64(self.line);
        writer.i64(self.column);
        debug_assert_eq!(writer.len(), Self::SIZE);
        writer.into_vec()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        ensure_row_len(bytes, Self::SIZE, "resolve ref")?;
        let mut reader = Reader::new(bytes);
        Ok(RefRow {
            id: reader.i64()?,
            from_node_id: reader.str_ref()?,
            reference_name: reader.str_ref()?,
            reference_kind: reader.str_ref()?,
            file_path: reader.str_ref()?,
            language: reader.str_ref()?,
            line: reader.i64()?,
            column: reader.i64()?,
        })
    }
}

/// Resolve external-strategy header (32 bytes).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExternalHeader {
    pub abi_version: u8,
    pub import_count: u32,
    pub jvm_count: u32,
    pub fw_group_count: u32,
    pub fw_cand_count: u32,
    pub also_count: u32,
    pub claimed_count: u32,
    pub path_count: u32,
}

impl ExternalHeader {
    pub const SIZE: usize = abi::RESOLVE_EXT_HEADER_SIZE;

    pub fn encode(&self) -> Vec<u8> {
        let mut writer = Writer::with_capacity(Self::SIZE);
        writer.u8(self.abi_version);
        writer.pad(3);
        writer.u32(self.import_count);
        writer.u32(self.jvm_count);
        writer.u32(self.fw_group_count);
        writer.u32(self.fw_cand_count);
        writer.u32(self.also_count);
        writer.u32(self.claimed_count);
        writer.u32(self.path_count);
        debug_assert_eq!(writer.len(), Self::SIZE);
        writer.into_vec()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        ensure_row_len(bytes, Self::SIZE, "resolve external header")?;
        let mut reader = Reader::new(bytes);
        let header = ExternalHeader {
            abi_version: reader.u8()?,
            import_count: {
                reader.skip(3)?;
                reader.u32()?
            },
            jvm_count: reader.u32()?,
            fw_group_count: reader.u32()?,
            fw_cand_count: reader.u32()?,
            also_count: reader.u32()?,
            claimed_count: reader.u32()?,
            path_count: reader.u32()?,
        };
        Ok(header)
    }
}

/// Import/JVM key row (32 bytes).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeyRow {
    pub file: StrRef,
    pub name: StrRef,
    pub kind: StrRef,
    pub target_node_id: StrRef,
}

impl KeyRow {
    pub const SIZE: usize = abi::RESOLVE_KEY_ROW_SIZE;

    pub fn encode(&self) -> Vec<u8> {
        let mut writer = Writer::with_capacity(Self::SIZE);
        writer.str_ref(self.file);
        writer.str_ref(self.name);
        writer.str_ref(self.kind);
        writer.str_ref(self.target_node_id);
        debug_assert_eq!(writer.len(), Self::SIZE);
        writer.into_vec()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        ensure_row_len(bytes, Self::SIZE, "resolve key")?;
        let mut reader = Reader::new(bytes);
        Ok(KeyRow {
            file: reader.str_ref()?,
            name: reader.str_ref()?,
            kind: reader.str_ref()?,
            target_node_id: reader.str_ref()?,
        })
    }
}

/// Framework group row (48 bytes). Position-keyed: same-name refs at
/// different lines resolve differently.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FwGroupRow {
    pub file: StrRef,
    pub name: StrRef,
    pub kind: StrRef,
    pub line: i64,
    pub column: i64,
    pub cand_start: u32,
    pub cand_end: u32,
}

impl FwGroupRow {
    pub const SIZE: usize = abi::RESOLVE_FW_GROUP_ROW_SIZE;

    pub fn encode(&self) -> Vec<u8> {
        let mut writer = Writer::with_capacity(Self::SIZE);
        writer.str_ref(self.file);
        writer.str_ref(self.name);
        writer.str_ref(self.kind);
        writer.i64(self.line);
        writer.i64(self.column);
        writer.u32(self.cand_start);
        writer.u32(self.cand_end);
        debug_assert_eq!(writer.len(), Self::SIZE);
        writer.into_vec()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        ensure_row_len(bytes, Self::SIZE, "resolve fw group")?;
        let mut reader = Reader::new(bytes);
        Ok(FwGroupRow {
            file: reader.str_ref()?,
            name: reader.str_ref()?,
            kind: reader.str_ref()?,
            line: reader.i64()?,
            column: reader.i64()?,
            cand_start: reader.u32()?,
            cand_end: reader.u32()?,
        })
    }
}

/// Framework candidate row (40 bytes).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FwCandidateRow {
    pub target_node_id: StrRef,
    /// 1 = import … 8 = fuzzy (`ResolvedBy` code).
    pub resolved_by: u8,
    pub authoritative: bool,
    pub edge_kind: StrRef,
    pub metadata: StrRef,
    pub also_start: u32,
    pub also_end: u32,
}

impl FwCandidateRow {
    pub const SIZE: usize = abi::RESOLVE_FW_CAND_ROW_SIZE;

    pub fn encode(&self) -> Vec<u8> {
        let mut writer = Writer::with_capacity(Self::SIZE);
        writer.str_ref(self.target_node_id);
        writer.u8(self.resolved_by);
        writer.u8(if self.authoritative { 1 } else { 0 });
        writer.pad(2);
        writer.str_ref(self.edge_kind);
        writer.str_ref(self.metadata);
        writer.u32(self.also_start);
        writer.u32(self.also_end);
        writer.pad(4);
        debug_assert_eq!(writer.len(), Self::SIZE);
        writer.into_vec()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        ensure_row_len(bytes, Self::SIZE, "resolve fw candidate")?;
        let mut reader = Reader::new(bytes);
        let target_node_id = reader.str_ref()?;
        let resolved_by = reader.u8()?;
        let authoritative = reader.u8()? != 0;
        reader.skip(2)?;
        let row = FwCandidateRow {
            target_node_id,
            resolved_by,
            authoritative,
            edge_kind: reader.str_ref()?,
            metadata: reader.str_ref()?,
            also_start: reader.u32()?,
            also_end: reader.u32()?,
        };
        reader.skip(4)?;
        Ok(row)
    }
}

/// Also-target row (16 bytes).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AlsoRow {
    pub target_node_id: StrRef,
    pub metadata: StrRef,
}

impl AlsoRow {
    pub const SIZE: usize = abi::RESOLVE_ALSO_ROW_SIZE;

    pub fn encode(&self) -> Vec<u8> {
        let mut writer = Writer::with_capacity(Self::SIZE);
        writer.str_ref(self.target_node_id);
        writer.str_ref(self.metadata);
        debug_assert_eq!(writer.len(), Self::SIZE);
        writer.into_vec()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        ensure_row_len(bytes, Self::SIZE, "resolve also")?;
        let mut reader = Reader::new(bytes);
        Ok(AlsoRow {
            target_node_id: reader.str_ref()?,
            metadata: reader.str_ref()?,
        })
    }
}

/// Claimed-name row (8 bytes) — one arena string reference.
pub fn decode_claimed_row(bytes: &[u8]) -> Result<StrRef> {
    ensure_row_len(bytes, abi::RESOLVE_CLAIMED_ROW_SIZE, "resolve claimed")?;
    let mut reader = Reader::new(bytes);
    reader.str_ref()
}

/// Import-path row (24 bytes).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PathRow {
    pub file: StrRef,
    pub source: StrRef,
    /// `NONE` means unresolvable/external.
    pub resolved: StrRef,
}

impl PathRow {
    pub const SIZE: usize = abi::RESOLVE_PATH_ROW_SIZE;

    pub fn encode(&self) -> Vec<u8> {
        let mut writer = Writer::with_capacity(Self::SIZE);
        writer.str_ref(self.file);
        writer.str_ref(self.source);
        writer.str_ref(self.resolved);
        debug_assert_eq!(writer.len(), Self::SIZE);
        writer.into_vec()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        ensure_row_len(bytes, Self::SIZE, "resolve path")?;
        let mut reader = Reader::new(bytes);
        Ok(PathRow {
            file: reader.str_ref()?,
            source: reader.str_ref()?,
            resolved: reader.str_ref()?,
        })
    }
}

/// Resolve output header (40 bytes).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OutHeader {
    pub abi_version: u8,
    pub batch_edge_count: u32,
    pub resolved_count: u32,
    pub failed_count: u32,
    pub sweep_count: u32,
    pub stat_count: u32,
    pub arena_len: u32,
    pub total: u32,
    pub resolved_total: u32,
    pub unresolved_total: u32,
}

impl OutHeader {
    pub const SIZE: usize = abi::RESOLVE_OUT_HEADER_SIZE;

    pub fn encode(&self) -> Vec<u8> {
        let mut writer = Writer::with_capacity(Self::SIZE);
        writer.u8(self.abi_version);
        writer.pad(3);
        writer.u32(self.batch_edge_count);
        writer.u32(self.resolved_count);
        writer.u32(self.failed_count);
        writer.u32(self.sweep_count);
        writer.u32(self.stat_count);
        writer.u32(self.arena_len);
        writer.u32(self.total);
        writer.u32(self.resolved_total);
        writer.u32(self.unresolved_total);
        debug_assert_eq!(writer.len(), Self::SIZE);
        writer.into_vec()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        ensure_row_len(bytes, Self::SIZE, "resolve out header")?;
        let mut reader = Reader::new(bytes);
        let header = OutHeader {
            abi_version: reader.u8()?,
            batch_edge_count: {
                reader.skip(3)?;
                reader.u32()?
            },
            resolved_count: reader.u32()?,
            failed_count: reader.u32()?,
            sweep_count: reader.u32()?,
            stat_count: reader.u32()?,
            arena_len: reader.u32()?,
            total: reader.u32()?,
            resolved_total: reader.u32()?,
            unresolved_total: reader.u32()?,
        };
        Ok(header)
    }
}

/// Resolve output edge row (80 bytes).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EdgeRow {
    pub source: StrRef,
    pub target: StrRef,
    pub kind: StrRef,
    pub line: i64,
    pub column: i64,
    pub target_metadata: StrRef,
    pub resolved_by: StrRef,
    pub ref_name: StrRef,
    pub ref_kind: StrRef,
    pub fn_ref: bool,
}

impl EdgeRow {
    pub const SIZE: usize = abi::RESOLVE_EDGE_ROW_SIZE;

    pub fn encode(&self) -> Vec<u8> {
        let mut writer = Writer::with_capacity(Self::SIZE);
        writer.str_ref(self.source);
        writer.str_ref(self.target);
        writer.str_ref(self.kind);
        writer.i64(self.line);
        writer.i64(self.column);
        writer.str_ref(self.target_metadata);
        writer.str_ref(self.resolved_by);
        writer.str_ref(self.ref_name);
        writer.str_ref(self.ref_kind);
        writer.u8(if self.fn_ref { 1 } else { 0 });
        writer.pad(7);
        debug_assert_eq!(writer.len(), Self::SIZE);
        writer.into_vec()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        ensure_row_len(bytes, Self::SIZE, "resolve edge")?;
        let mut reader = Reader::new(bytes);
        let row = EdgeRow {
            source: reader.str_ref()?,
            target: reader.str_ref()?,
            kind: reader.str_ref()?,
            line: reader.i64()?,
            column: reader.i64()?,
            target_metadata: reader.str_ref()?,
            resolved_by: reader.str_ref()?,
            ref_name: reader.str_ref()?,
            ref_kind: reader.str_ref()?,
            fn_ref: reader.u8()? != 0,
        };
        reader.skip(7)?;
        Ok(row)
    }
}

/// Resolve output ref row (40 bytes).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OutRefRow {
    /// 1 = resolved (delete), 2 = unresolved (mark failed).
    pub flag: u8,
    /// Row id; `-1` means absent (only meaningful on resolved rows).
    pub id: i64,
    pub from_node_id: StrRef,
    pub reference_name: StrRef,
    pub reference_kind: StrRef,
}

impl OutRefRow {
    pub const SIZE: usize = abi::RESOLVE_OUT_REF_ROW_SIZE;

    pub fn encode(&self) -> Vec<u8> {
        let mut writer = Writer::with_capacity(Self::SIZE);
        writer.u8(self.flag);
        writer.pad(7);
        writer.i64(self.id);
        writer.str_ref(self.from_node_id);
        writer.str_ref(self.reference_name);
        writer.str_ref(self.reference_kind);
        debug_assert_eq!(writer.len(), Self::SIZE);
        writer.into_vec()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        ensure_row_len(bytes, Self::SIZE, "resolve out ref")?;
        let mut reader = Reader::new(bytes);
        let flag = reader.u8()?;
        reader.skip(7)?;
        Ok(OutRefRow {
            flag,
            id: reader.i64()?,
            from_node_id: reader.str_ref()?,
            reference_name: reader.str_ref()?,
            reference_kind: reader.str_ref()?,
        })
    }
}

/// Resolve file-sweep row (24 bytes).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SweepRow {
    pub source_node_id: StrRef,
    pub edge_start: u32,
    pub edge_end: u32,
}

impl SweepRow {
    pub const SIZE: usize = abi::RESOLVE_SWEEP_ROW_SIZE;

    pub fn encode(&self) -> Vec<u8> {
        let mut writer = Writer::with_capacity(Self::SIZE);
        writer.str_ref(self.source_node_id);
        writer.u32(self.edge_start);
        writer.u32(self.edge_end);
        writer.pad(8);
        debug_assert_eq!(writer.len(), Self::SIZE);
        writer.into_vec()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        ensure_row_len(bytes, Self::SIZE, "resolve sweep")?;
        let mut reader = Reader::new(bytes);
        let row = SweepRow {
            source_node_id: reader.str_ref()?,
            edge_start: reader.u32()?,
            edge_end: reader.u32()?,
        };
        reader.skip(8)?;
        Ok(row)
    }
}

/// Resolve stats row (16 bytes).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StatRow {
    pub by_method: StrRef,
    pub count: u32,
}

impl StatRow {
    pub const SIZE: usize = abi::RESOLVE_STAT_ROW_SIZE;

    pub fn encode(&self) -> Vec<u8> {
        let mut writer = Writer::with_capacity(Self::SIZE);
        writer.str_ref(self.by_method);
        writer.u32(self.count);
        writer.pad(4);
        debug_assert_eq!(writer.len(), Self::SIZE);
        writer.into_vec()
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        ensure_row_len(bytes, Self::SIZE, "resolve stat")?;
        let mut reader = Reader::new(bytes);
        let row = StatRow {
            by_method: reader.str_ref()?,
            count: reader.u32()?,
        };
        reader.skip(4)?;
        Ok(row)
    }
}

/// Borrowed resolve input buffers.
#[derive(Debug, Clone, Copy)]
pub struct InBuffers<'a> {
    pub meta: &'a [u8],
    pub refs: &'a [u8],
    pub external: &'a [u8],
    pub arena: &'a [u8],
}

impl<'a> InBuffers<'a> {
    pub fn meta(&self) -> Result<Meta> {
        Meta::decode(self.meta)
    }

    pub fn ref_row(&self, index: u32) -> Result<RefRow> {
        let offset = index as usize * RefRow::SIZE;
        let mut reader = reader_at(self.refs, offset, RefRow::SIZE, "resolve ref")?;
        decode_ref(&mut reader)
    }

    pub fn external_header(&self) -> Result<ExternalHeader> {
        ExternalHeader::decode(self.external)
    }

    /// Verify the ABI, arena bound, and ref table length.
    pub fn validate(&self) -> Result<Meta> {
        let meta = self.meta()?;
        if meta.abi_version != abi::RESOLVE_ABI_VERSION {
            return Err(CoreError::wire(format!(
                "resolve wire: abi {} != RESOLVE_ABI_VERSION {}",
                meta.abi_version,
                abi::RESOLVE_ABI_VERSION
            )));
        }
        if meta.arena_len as usize > self.arena.len() {
            return Err(CoreError::wire(format!(
                "resolve wire: arena_len {} > arena buffer {}",
                meta.arena_len,
                self.arena.len()
            )));
        }
        let required = meta.ref_count as usize * RefRow::SIZE;
        if self.refs.len() < required {
            return Err(CoreError::wire(format!(
                "resolve wire: refs buffer {} < {} rows × {} bytes",
                self.refs.len(),
                meta.ref_count,
                RefRow::SIZE
            )));
        }
        Ok(meta)
    }
}

/// Borrowed resolve output buffers.
#[derive(Debug, Clone, Copy)]
pub struct OutBuffers<'a> {
    pub header: &'a [u8],
    pub edges: &'a [u8],
    pub refs: &'a [u8],
    pub files: &'a [u8],
    pub stats: &'a [u8],
    pub arena: &'a [u8],
}

impl<'a> OutBuffers<'a> {
    pub fn header(&self) -> Result<OutHeader> {
        OutHeader::decode(self.header)
    }

    pub fn edge(&self, index: u32) -> Result<EdgeRow> {
        let offset = index as usize * EdgeRow::SIZE;
        let mut reader = reader_at(self.edges, offset, EdgeRow::SIZE, "resolve edge")?;
        decode_edge(&mut reader)
    }

    pub fn ref_row(&self, index: u32) -> Result<OutRefRow> {
        let offset = index as usize * OutRefRow::SIZE;
        let mut reader = reader_at(self.refs, offset, OutRefRow::SIZE, "resolve out ref")?;
        decode_out_ref(&mut reader)
    }

    pub fn sweep(&self, index: u32) -> Result<SweepRow> {
        let offset = index as usize * SweepRow::SIZE;
        let mut reader = reader_at(self.files, offset, SweepRow::SIZE, "resolve sweep")?;
        decode_sweep(&mut reader)
    }

    pub fn stat(&self, index: u32) -> Result<StatRow> {
        let offset = index as usize * StatRow::SIZE;
        let mut reader = reader_at(self.stats, offset, StatRow::SIZE, "resolve stat")?;
        decode_stat(&mut reader)
    }

    /// Verify the ABI, arena bound, and every declared table length.
    pub fn validate(&self) -> Result<OutHeader> {
        let header = self.header()?;
        if header.abi_version != abi::RESOLVE_ABI_VERSION {
            return Err(CoreError::wire(format!(
                "resolve wire: abi {} != RESOLVE_ABI_VERSION {}",
                header.abi_version,
                abi::RESOLVE_ABI_VERSION
            )));
        }
        if header.arena_len as usize > self.arena.len() {
            return Err(CoreError::wire(format!(
                "resolve wire: arena_len {} > arena buffer {}",
                header.arena_len,
                self.arena.len()
            )));
        }
        check_table(self.edges, header.batch_edge_count, EdgeRow::SIZE, "edges")?;
        check_table(
            self.refs,
            header.resolved_count + header.failed_count,
            OutRefRow::SIZE,
            "refs",
        )?;
        check_table(self.files, header.sweep_count, SweepRow::SIZE, "files")?;
        check_table(self.stats, header.stat_count, StatRow::SIZE, "stats")?;
        // Sweep ranges index the edge table after the batch edges; the header
        // does not carry the total sweep-edge count, so validate each range
        // against the actual buffer length.
        let edge_rows = (self.edges.len() / EdgeRow::SIZE) as u32;
        for index in 0..header.sweep_count {
            let sweep = self.sweep(index)?;
            if sweep.edge_start > sweep.edge_end || sweep.edge_end > edge_rows {
                return Err(CoreError::wire(format!(
                    "resolve wire: sweep {index} edge range {}..{} outside {edge_rows} rows",
                    sweep.edge_start, sweep.edge_end
                )));
            }
        }
        Ok(header)
    }
}

fn check_table(buf: &[u8], count: u32, row_size: usize, what: &str) -> Result<()> {
    let required = count as usize * row_size;
    if buf.len() < required {
        return Err(CoreError::wire(format!(
            "resolve wire: {what} buffer {} < {count} rows × {row_size} bytes",
            buf.len()
        )));
    }
    Ok(())
}

fn decode_ref(reader: &mut Reader<'_>) -> Result<RefRow> {
    Ok(RefRow {
        id: reader.i64()?,
        from_node_id: reader.str_ref()?,
        reference_name: reader.str_ref()?,
        reference_kind: reader.str_ref()?,
        file_path: reader.str_ref()?,
        language: reader.str_ref()?,
        line: reader.i64()?,
        column: reader.i64()?,
    })
}

fn decode_edge(reader: &mut Reader<'_>) -> Result<EdgeRow> {
    let row = EdgeRow {
        source: reader.str_ref()?,
        target: reader.str_ref()?,
        kind: reader.str_ref()?,
        line: reader.i64()?,
        column: reader.i64()?,
        target_metadata: reader.str_ref()?,
        resolved_by: reader.str_ref()?,
        ref_name: reader.str_ref()?,
        ref_kind: reader.str_ref()?,
        fn_ref: reader.u8()? != 0,
    };
    reader.skip(7)?;
    Ok(row)
}

fn decode_out_ref(reader: &mut Reader<'_>) -> Result<OutRefRow> {
    let flag = reader.u8()?;
    reader.skip(7)?;
    Ok(OutRefRow {
        flag,
        id: reader.i64()?,
        from_node_id: reader.str_ref()?,
        reference_name: reader.str_ref()?,
        reference_kind: reader.str_ref()?,
    })
}

fn decode_sweep(reader: &mut Reader<'_>) -> Result<SweepRow> {
    let row = SweepRow {
        source_node_id: reader.str_ref()?,
        edge_start: reader.u32()?,
        edge_end: reader.u32()?,
    };
    reader.skip(8)?;
    Ok(row)
}

fn decode_stat(reader: &mut Reader<'_>) -> Result<StatRow> {
    let row = StatRow {
        by_method: reader.str_ref()?,
        count: reader.u32()?,
    };
    reader.skip(4)?;
    Ok(row)
}
