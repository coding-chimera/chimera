//! E-GRAPH port v1 vocabulary and object safety.

use codewhale_codegraph::contract::egraph::{
    CODEPLAN_ATOMIC_LABELS, CODEPLAN_RELATION_KINDS, ChangeFact, ChangeKind, ChangeSubjectKind,
    CodePlanAtomicLabel, EGraphPort, GraphStatus, ImpactLabel, ImpactLabelResult, MayImpactRule,
    PropagationEntry, PropagationResult, PropagationSeed, PropagationTarget, RELATION_KINDS,
};
use codewhale_codegraph::wire::error::CoreError;

struct FakePort;

impl EGraphPort for FakePort {
    fn status(&self) -> Result<GraphStatus, CoreError> {
        Ok(GraphStatus {
            initialized: true,
            data_root_status: "current".to_string(),
            revision: Some("rev".to_string()),
        })
    }

    fn classify_change(&self, _fact: &ChangeFact) -> Result<ImpactLabelResult, CoreError> {
        Ok(ImpactLabelResult {
            label: ImpactLabel::Unknown,
            code_plan_atomic_label: None,
            confidence: 0.0,
            reason: "fake".to_string(),
            fallback_reason: None,
            body_effect: None,
            signals: vec![],
        })
    }

    fn may_impact_rule(&self, _label: &ImpactLabelResult) -> Result<MayImpactRule, CoreError> {
        Ok(MayImpactRule {
            id: "unknown.conservative_fallback".to_string(),
            relation_kinds: vec!["CalledBy".to_string()],
            relation_clauses: vec![],
            code_plan_atomic_labels: vec![],
            include_file_dependents: true,
            include_impact_radius: true,
            self_review_only: false,
            reason: "fake".to_string(),
        })
    }

    fn seed_nodes(
        &self,
        _targets: &[PropagationTarget],
    ) -> Result<Vec<PropagationSeed>, CoreError> {
        Ok(vec![])
    }

    fn propagation(
        &self,
        _targets: &[PropagationTarget],
        _max_depth: u8,
    ) -> Result<PropagationResult, CoreError> {
        Ok(PropagationResult {
            entries: vec![PropagationEntry {
                file: "src/a.ts".to_string(),
                symbols: vec!["run".to_string()],
                line: Some(1),
                via: None,
                depth: 1,
            }],
            degraded: None,
        })
    }
}

#[test]
fn port_is_object_safe() {
    let port: Box<dyn EGraphPort> = Box::new(FakePort);
    assert!(port.status().unwrap().initialized);
    let result = port.propagation(&[], 4).unwrap();
    assert_eq!(result.entries.len(), 1);
    assert!(result.degraded.is_none());
}

#[test]
fn change_vocabulary_round_trips() {
    for kind in [
        ChangeKind::Add,
        ChangeKind::Modify,
        ChangeKind::Delete,
        ChangeKind::Move,
    ] {
        assert_eq!(ChangeKind::parse(kind.as_str()), Some(kind));
    }
    for subject in [
        ChangeSubjectKind::File,
        ChangeSubjectKind::Body,
        ChangeSubjectKind::Signature,
        ChangeSubjectKind::Import,
        ChangeSubjectKind::Export,
        ChangeSubjectKind::Route,
        ChangeSubjectKind::Schema,
        ChangeSubjectKind::Config,
        ChangeSubjectKind::Test,
        ChangeSubjectKind::Doc,
        ChangeSubjectKind::Unknown,
    ] {
        assert_eq!(ChangeSubjectKind::parse(subject.as_str()), Some(subject));
    }
}

#[test]
fn codeplan_atomic_labels_match_the_graph_table() {
    assert_eq!(CODEPLAN_ATOMIC_LABELS.len(), 16);
    for label in CODEPLAN_ATOMIC_LABELS {
        let parsed = CodePlanAtomicLabel::parse(label).expect("every label parses");
        assert_eq!(parsed.as_str(), label);
    }
    assert_eq!(CodePlanAtomicLabel::parse("NOPE"), None);
}

#[test]
fn relation_vocabularies_are_frozen() {
    assert_eq!(RELATION_KINDS.len(), 16);
    assert_eq!(CODEPLAN_RELATION_KINDS.len(), 16);
    assert!(RELATION_KINDS.contains(&"CalledBy"));
    assert!(CODEPLAN_RELATION_KINDS.contains(&"ConstructedBy"));
}

#[test]
fn impact_labels_have_stable_strings() {
    let labels = [
        ImpactLabel::MethodSignature,
        ImpactLabel::MethodBody,
        ImpactLabel::Field,
        ImpactLabel::ClassDeclaration,
        ImpactLabel::ConstructorSignature,
        ImpactLabel::ImportStatement,
        ImpactLabel::ExportBoundary,
        ImpactLabel::RouteContract,
        ImpactLabel::SchemaContract,
        ImpactLabel::ConfigBoundary,
        ImpactLabel::TestContract,
        ImpactLabel::DocContract,
        ImpactLabel::FileBoundary,
        ImpactLabel::Unknown,
    ];
    let strings: Vec<_> = labels.iter().map(|label| label.as_str()).collect();
    assert_eq!(strings.len(), 14);
    assert!(strings.contains(&"method_body"));
    assert!(strings.contains(&"file_boundary"));
    assert!(strings.contains(&"unknown"));
}
