//! E-GRAPH port v1 — the semantic-supply contract.
//!
//! Consumer: control-plane CTL-01/02/03 (`GraphProbe`, risk classification,
//! seed nodes, propagation impact; see
//! `specs/rust-host/tracks/control-plane.md` §3.1 E-GRAPH row).
//! Implementer: DG-11 (`core::semantics`). During W3 the same surface may be
//! supplied by the TypeScript proxy; the port vocabulary is what both arms
//! must satisfy.
//!
//! The port is deliberately expressed in neutral data types — no store/ctx
//! handle types — so DG-01 (L0) can freeze it before DG-02/DG-09 exist.
//! Adapters translate TS `ChangeFact` records into [`ChangeFact`] here.
//!
//! Coordinate discipline: every [`SourceRange`] column is a 0-based UTF-16
//! code unit, `end` is exclusive, and lines are 1-based — the same contract as
//! graph node ranges (`graph/known-pitfalls.md` §1, U1/U3). Never put UTF-8
//! byte offsets in these fields.
//!
//! Budget discipline: [`EGraphPort::propagation`] must degrade silently when
//! the walk exceeds its node/time/depth budget, mirroring the TS probe
//! (`propagation-probe.ts`: 500 ms, 40 files, depth 4, frontier 8). Degradation
//! is reported through [`PropagationResult::degraded`], never as an error.

use crate::wire::error::CoreError;

/// Port result type.
pub type Result<T> = std::result::Result<T, CoreError>;

// ---------------------------------------------------------------------------
// Change vocabulary
// ---------------------------------------------------------------------------

/// `change-classifier.ts` `ChangeKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ChangeKind {
    Add,
    Modify,
    Delete,
    Move,
}

impl ChangeKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            ChangeKind::Add => "add",
            ChangeKind::Modify => "modify",
            ChangeKind::Delete => "delete",
            ChangeKind::Move => "move",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "add" => Some(ChangeKind::Add),
            "modify" => Some(ChangeKind::Modify),
            "delete" => Some(ChangeKind::Delete),
            "move" => Some(ChangeKind::Move),
            _ => None,
        }
    }
}

/// `change-classifier.ts` `ChangeSubjectKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ChangeSubjectKind {
    File,
    Body,
    Signature,
    Import,
    Export,
    Route,
    Schema,
    Config,
    Test,
    Doc,
    Unknown,
}

impl ChangeSubjectKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            ChangeSubjectKind::File => "file",
            ChangeSubjectKind::Body => "body",
            ChangeSubjectKind::Signature => "signature",
            ChangeSubjectKind::Import => "import",
            ChangeSubjectKind::Export => "export",
            ChangeSubjectKind::Route => "route",
            ChangeSubjectKind::Schema => "schema",
            ChangeSubjectKind::Config => "config",
            ChangeSubjectKind::Test => "test",
            ChangeSubjectKind::Doc => "doc",
            ChangeSubjectKind::Unknown => "unknown",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "file" => Some(ChangeSubjectKind::File),
            "body" => Some(ChangeSubjectKind::Body),
            "signature" => Some(ChangeSubjectKind::Signature),
            "import" => Some(ChangeSubjectKind::Import),
            "export" => Some(ChangeSubjectKind::Export),
            "route" => Some(ChangeSubjectKind::Route),
            "schema" => Some(ChangeSubjectKind::Schema),
            "config" => Some(ChangeSubjectKind::Config),
            "test" => Some(ChangeSubjectKind::Test),
            "doc" => Some(ChangeSubjectKind::Doc),
            "unknown" => Some(ChangeSubjectKind::Unknown),
            _ => None,
        }
    }
}

/// `impact-label.ts` `BodyImpactEffect`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum BodyImpactEffect {
    LocalOnly,
    CallerVisible,
    UnknownBodyEffect,
}

impl BodyImpactEffect {
    pub const fn as_str(self) -> &'static str {
        match self {
            BodyImpactEffect::LocalOnly => "local_only",
            BodyImpactEffect::CallerVisible => "caller_visible",
            BodyImpactEffect::UnknownBodyEffect => "unknown_body_effect",
        }
    }
}

/// `evidence.statementEffect.effect` (CodePlan statement-effect evidence).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum StatementEffect {
    LocalOnly,
    CallerVisible,
    UnknownFallback,
}

impl StatementEffect {
    pub const fn as_str(self) -> &'static str {
        match self {
            StatementEffect::LocalOnly => "local_only",
            StatementEffect::CallerVisible => "caller_visible",
            StatementEffect::UnknownFallback => "unknown_fallback",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "local_only" => Some(StatementEffect::LocalOnly),
            "caller_visible" => Some(StatementEffect::CallerVisible),
            "unknown_fallback" => Some(StatementEffect::UnknownFallback),
            _ => None,
        }
    }
}

/// `impact-label.ts` `ImpactLabel`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ImpactLabel {
    MethodSignature,
    MethodBody,
    Field,
    ClassDeclaration,
    ConstructorSignature,
    ImportStatement,
    ExportBoundary,
    RouteContract,
    SchemaContract,
    ConfigBoundary,
    TestContract,
    DocContract,
    FileBoundary,
    Unknown,
}

impl ImpactLabel {
    pub const fn as_str(self) -> &'static str {
        match self {
            ImpactLabel::MethodSignature => "method_signature",
            ImpactLabel::MethodBody => "method_body",
            ImpactLabel::Field => "field",
            ImpactLabel::ClassDeclaration => "class_declaration",
            ImpactLabel::ConstructorSignature => "constructor_signature",
            ImpactLabel::ImportStatement => "import_statement",
            ImpactLabel::ExportBoundary => "export_boundary",
            ImpactLabel::RouteContract => "route_contract",
            ImpactLabel::SchemaContract => "schema_contract",
            ImpactLabel::ConfigBoundary => "config_boundary",
            ImpactLabel::TestContract => "test_contract",
            ImpactLabel::DocContract => "doc_contract",
            ImpactLabel::FileBoundary => "file_boundary",
            ImpactLabel::Unknown => "unknown",
        }
    }
}

/// `graph/types.ts` `CODEPLAN_ATOMIC_LABELS` — exact order.
pub const CODEPLAN_ATOMIC_LABELS: [&str; 16] = [
    "MMB", "MMS", "MF", "MC", "MCC", "MI", "AM", "AF", "AC", "ACC", "AI", "DM", "DF", "DC", "DCC",
    "DI",
];

/// CodePlan atomic label.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CodePlanAtomicLabel {
    Mmb,
    Mms,
    Mf,
    Mc,
    Mcc,
    Mi,
    Am,
    Af,
    Ac,
    Acc,
    Ai,
    Dm,
    Df,
    Dc,
    Dcc,
    Di,
}

impl CodePlanAtomicLabel {
    pub const fn as_str(self) -> &'static str {
        match self {
            CodePlanAtomicLabel::Mmb => "MMB",
            CodePlanAtomicLabel::Mms => "MMS",
            CodePlanAtomicLabel::Mf => "MF",
            CodePlanAtomicLabel::Mc => "MC",
            CodePlanAtomicLabel::Mcc => "MCC",
            CodePlanAtomicLabel::Mi => "MI",
            CodePlanAtomicLabel::Am => "AM",
            CodePlanAtomicLabel::Af => "AF",
            CodePlanAtomicLabel::Ac => "AC",
            CodePlanAtomicLabel::Acc => "ACC",
            CodePlanAtomicLabel::Ai => "AI",
            CodePlanAtomicLabel::Dm => "DM",
            CodePlanAtomicLabel::Df => "DF",
            CodePlanAtomicLabel::Dc => "DC",
            CodePlanAtomicLabel::Dcc => "DCC",
            CodePlanAtomicLabel::Di => "DI",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "MMB" => CodePlanAtomicLabel::Mmb,
            "MMS" => CodePlanAtomicLabel::Mms,
            "MF" => CodePlanAtomicLabel::Mf,
            "MC" => CodePlanAtomicLabel::Mc,
            "MCC" => CodePlanAtomicLabel::Mcc,
            "MI" => CodePlanAtomicLabel::Mi,
            "AM" => CodePlanAtomicLabel::Am,
            "AF" => CodePlanAtomicLabel::Af,
            "AC" => CodePlanAtomicLabel::Ac,
            "ACC" => CodePlanAtomicLabel::Acc,
            "AI" => CodePlanAtomicLabel::Ai,
            "DM" => CodePlanAtomicLabel::Dm,
            "DF" => CodePlanAtomicLabel::Df,
            "DC" => CodePlanAtomicLabel::Dc,
            "DCC" => CodePlanAtomicLabel::Dcc,
            "DI" => CodePlanAtomicLabel::Di,
            _ => return None,
        })
    }
}

/// `graph/types.ts` `RELATION_KINDS` — legacy relation vocabulary.
pub const RELATION_KINDS: [&str; 16] = [
    "CalledBy",
    "Calls",
    "ImportedBy",
    "Imports",
    "UsedBy",
    "Uses",
    "InstantiatedBy",
    "Instantiates",
    "BaseClassOf",
    "DerivedClassOf",
    "Overrides",
    "OverriddenBy",
    "DecoratedBy",
    "Decorates",
    "Contains",
    "ContainedBy",
];

/// `graph/types.ts` `CODEPLAN_RELATION_KINDS`.
pub const CODEPLAN_RELATION_KINDS: [&str; 16] = [
    "ParentOf",
    "ChildOf",
    "Construct",
    "ConstructedBy",
    "Imports",
    "ImportedBy",
    "BaseClassOf",
    "DerivedClassOf",
    "Overrides",
    "OverriddenBy",
    "Calls",
    "CalledBy",
    "Instantiates",
    "InstantiatedBy",
    "Uses",
    "UsedBy",
];

/// Which graph a CodePlan relation clause reads: `D` (before) or `D'`
/// (after).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RelationGraph {
    Before,
    After,
}

impl RelationGraph {
    pub const fn as_str(self) -> &'static str {
        match self {
            RelationGraph::Before => "D",
            RelationGraph::After => "D'",
        }
    }
}

// ---------------------------------------------------------------------------
// Input / output data
// ---------------------------------------------------------------------------

/// Flattened `ChangeFact` — exactly the fields the classifier and may-impact
/// rules consume. `node_kind`/`node_name` come from
/// `evidence.afterNode ?? evidence.beforeNode`; `statement_effect` and
/// `signals` come from `evidence`.
#[derive(Debug, Clone, PartialEq)]
pub struct ChangeFact {
    pub id: String,
    pub event_id: String,
    pub file_path: String,
    pub old_path: Option<String>,
    pub node_id: Option<String>,
    pub node_key: Option<String>,
    pub change_kind: ChangeKind,
    pub subject_kind: ChangeSubjectKind,
    pub confidence: f64,
    pub node_kind: Option<String>,
    pub node_name: Option<String>,
    pub statement_effect: Option<StatementEffect>,
    pub signals: Vec<String>,
}

/// `impact-label.ts` `ImpactLabelResult`.
#[derive(Debug, Clone, PartialEq)]
pub struct ImpactLabelResult {
    pub label: ImpactLabel,
    pub code_plan_atomic_label: Option<CodePlanAtomicLabel>,
    pub confidence: f64,
    pub reason: String,
    pub fallback_reason: Option<String>,
    pub body_effect: Option<BodyImpactEffect>,
    pub signals: Vec<String>,
}

/// One CodePlan relation clause (`graph` + `relation`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MayImpactRelationClause {
    pub graph: RelationGraph,
    /// One of [`CODEPLAN_RELATION_KINDS`].
    pub relation: String,
}

/// `may-impact-rules.ts` `MayImpactRule`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MayImpactRule {
    pub id: String,
    /// Legacy relation vocabulary (`RELATION_KINDS`); empty for CodePlan
    /// rules.
    pub relation_kinds: Vec<String>,
    pub relation_clauses: Vec<MayImpactRelationClause>,
    pub code_plan_atomic_labels: Vec<CodePlanAtomicLabel>,
    pub include_file_dependents: bool,
    pub include_impact_radius: bool,
    pub self_review_only: bool,
    pub reason: String,
}

/// One edit target. `ranges` are PRE-EDIT ranges; `None` means the legacy
/// file-level walk (the TS probe's `ranges === undefined` branch).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PropagationTarget {
    pub file: String,
    pub ranges: Option<Vec<SourceRange>>,
}

/// A 1-based line / 0-based UTF-16 column range, `end` exclusive.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct SourceRange {
    pub start_line: u32,
    pub start_column: u32,
    pub end_line: u32,
    pub end_column: u32,
}

/// One resolved seed node.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PropagationSeed {
    pub node_id: String,
    pub file: String,
    pub name: String,
    pub kind: String,
    pub start_line: u32,
}

/// One dependent entry of the bounded walk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PropagationEntry {
    pub file: String,
    /// Consumer symbol names (empty for file-granularity dependents).
    pub symbols: Vec<String>,
    /// 1-based line of the first symbol, when symbol-level.
    pub line: Option<u32>,
    /// Intermediate `symbol@file` annotation, when the entry was reached
    /// through a bridge.
    pub via: Option<String>,
    /// External hops only; same-file bridge jumps are free.
    pub depth: u32,
}

/// Why a propagation walk stopped early.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PropagationDegrade {
    /// The caller's wall-clock budget expired (TS: 500 ms).
    TimeBudget,
    /// The visited-file cap was reached (TS: 40 files).
    NodeBudget,
    /// The depth cap was reached (TS: 4 external hops).
    DepthBudget,
    /// A level's frontier cap was reached (TS: 8 vertices).
    FrontierBudget,
}

/// Result of [`EGraphPort::propagation`]. Degradation is data, not an error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PropagationResult {
    pub entries: Vec<PropagationEntry>,
    pub degraded: Option<PropagationDegrade>,
}

/// Graph readiness snapshot used by the mutation gate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GraphStatus {
    pub initialized: bool,
    /// `uninitialized` / `current` / `legacy` / `mixed` / `custom` — the
    /// data-root classification from `src/graph/directory.ts`.
    pub data_root_status: String,
    pub revision: Option<String>,
}

// ---------------------------------------------------------------------------
// Port
// ---------------------------------------------------------------------------

/// E-GRAPH semantic supply. Object-safe; the consumer owns threading and
/// cancellation policy (core stays synchronous).
pub trait EGraphPort {
    /// Readiness + data-root classification. Must not initialize, migrate, or
    /// create any graph data (read-only rule).
    fn status(&self) -> Result<GraphStatus>;

    /// `deriveImpactLabel` — impact label + CodePlan atomic label.
    fn classify_change(&self, fact: &ChangeFact) -> Result<ImpactLabelResult>;

    /// `dispatchMayImpactRule` — the rule for a classified change.
    fn may_impact_rule(&self, label: &ImpactLabelResult) -> Result<MayImpactRule>;

    /// Resolve edit targets to seed nodes (symbols intersecting the ranges).
    /// Empty ranges fall back to file-level seeds.
    fn seed_nodes(&self, targets: &[PropagationTarget]) -> Result<Vec<PropagationSeed>>;

    /// Bounded dependent walk. `max_depth` is the external-hop cap; the
    /// implementation still applies its own node/time/frontier budgets and
    /// reports any early stop through [`PropagationResult::degraded`].
    fn propagation(
        &self,
        targets: &[PropagationTarget],
        max_depth: u8,
    ) -> Result<PropagationResult>;
}
