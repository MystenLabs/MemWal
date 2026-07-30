use sui_sdk_types::{ExecutionError, ExecutionStatus};

/// Walrus's `system` module.
const WALRUS_SYSTEM_MODULE: &str = "system";
/// The version-guard accessors in Walrus's `system` module. Per its Move source, both assert
/// `system.version == VERSION` and abort `EWrongVersion`; nothing else in the module does:
///
/// ```move
/// public(package) fun inner(system: &System): &SystemStateInnerV1 {
///     assert!(system.version == VERSION, EWrongVersion);
///     dynamic_field::borrow(&system.id, VERSION)
/// }
/// ```
///
/// Pinning the FUNCTION (not just the module) keeps this narrow: `system::delete_blob` and its
/// siblings have their own per-blob assertions, and abort codes are per-module ordinals, so a
/// legitimate per-blob abort could also be `code == 1` in this module. Only an abort inside the
/// version accessors is a whole-transaction fault.
const WALRUS_VERSION_GUARD_FUNCTIONS: [&str; 2] = ["inner", "inner_mut"];
/// `EWrongVersion` — the version guard's abort code.
const WALRUS_E_WRONG_VERSION: u64 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FailureClass {
    CulpritInput {
        input_index: usize,
    },
    SharedObjectCongestion,
    /// The transaction is unexecutable as a whole; no input is at fault. Nothing may be
    /// evicted — every row is released and the batch fails with a global reason.
    WholeTransaction {
        reason: &'static str,
    },
    Ambiguous,
}

/// Reason string for a Walrus package upgrade, surfaced to clients in the error details.
pub const REASON_PACKAGE_UPGRADED: &str = "walrus_package_upgraded";

/// Classify committed, structured execution failures. For transactions built
/// by `tx_build`, delete command `i` consumes owned blob input `i + 1` because
/// PTB input zero is the shared System object.
pub fn classify_execution_failure(status: &ExecutionStatus) -> FailureClass {
    let ExecutionStatus::Failure { error, command } = status else {
        return FailureClass::Ambiguous;
    };
    match error {
        ExecutionError::ExecutionCanceledDueToConsensusObjectCongestion { .. } => {
            FailureClass::SharedObjectCongestion
        }
        // A version-guard abort inside Walrus's `system` module means the transaction was
        // built against a package Walrus has since upgraded away from. Every command in the
        // PTB touches the shared System object, so command 0 aborts first — but the blob it
        // nominally names is INNOCENT, and blaming it would run a live blob through the
        // eviction path and can terminalize it `expired` forever. Classify it globally.
        ExecutionError::MoveAbort { location, code }
            if location.module.as_str() == WALRUS_SYSTEM_MODULE
                && *code == WALRUS_E_WRONG_VERSION
                && location.function_name.as_ref().is_some_and(|name| {
                    WALRUS_VERSION_GUARD_FUNCTIONS.contains(&name.as_str())
                }) =>
        {
            FailureClass::WholeTransaction {
                reason: REASON_PACKAGE_UPGRADED,
            }
        }
        ExecutionError::InputObjectDeleted
        | ExecutionError::MoveAbort { .. }
        | ExecutionError::CommandArgumentError { .. } => command
            .map(|command| FailureClass::CulpritInput {
                input_index: (command as usize).saturating_add(1),
            })
            .unwrap_or(FailureClass::Ambiguous),
        _ => FailureClass::Ambiguous,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sui_sdk_types::{Identifier, MoveLocation};

    #[test]
    fn delete_command_maps_to_owned_input() {
        let status = ExecutionStatus::Failure {
            error: ExecutionError::InputObjectDeleted,
            command: Some(2),
        };
        assert_eq!(
            classify_execution_failure(&status),
            FailureClass::CulpritInput { input_index: 3 }
        );
    }

    /// A per-blob abort raised INSIDE `system::delete_blob` — the same module as the version
    /// guard — must still blame the owned input its command consumed. This is the case the
    /// `WholeTransaction` guard endangers, so keep the module fixed at `system` and vary only
    /// the function and code: only `system::inner`/`inner_mut` with code 1 is global.
    #[test]
    fn move_abort_at_delete_command_maps_to_owned_input() {
        let status = ExecutionStatus::Failure {
            error: ExecutionError::MoveAbort {
                location: MoveLocation {
                    package: "0x2".parse().unwrap(),
                    module: Identifier::from_static("system"),
                    function: 0,
                    instruction: 0,
                    function_name: Some(Identifier::from_static("delete_blob")),
                },
                code: 1,
            },
            command: Some(0),
        };
        assert_eq!(
            classify_execution_failure(&status),
            FailureClass::CulpritInput { input_index: 1 },
            "abort code 1 in system::delete_blob is a per-blob fault, not the version guard"
        );
    }

    /// Walrus's `system::inner` asserts `system.version == VERSION` and aborts
    /// `EWrongVersion` (code 1) when a SUPERSEDED package calls it — which happens to every
    /// transaction built before a Walrus package upgrade. Observed on testnet 2026-07-13:
    ///
    ///   MoveAbort in 1st command, abort code: 1, in '0xd84704c1…::system::inner'
    ///
    /// Every command in a delete PTB touches the shared System object, so command 0 aborts
    /// first — but the blob it nominally names is INNOCENT. Classifying that as a
    /// `CulpritInput` runs a live blob through the eviction path, where it can be
    /// terminalized `expired` FOREVER for a reason that has nothing to do with it.
    ///
    /// This is a WHOLE-TRANSACTION fault: release every row, evict nothing.
    #[test]
    fn walrus_version_guard_abort_is_a_whole_transaction_failure_not_a_culprit_blob() {
        let status = ExecutionStatus::Failure {
            error: ExecutionError::MoveAbort {
                location: MoveLocation {
                    package: "0x2".parse().unwrap(),
                    module: Identifier::from_static("system"),
                    function: 0,
                    instruction: 0,
                    function_name: Some(Identifier::from_static("inner")),
                },
                code: WALRUS_E_WRONG_VERSION,
            },
            command: Some(0),
        };
        assert_eq!(
            classify_execution_failure(&status),
            FailureClass::WholeTransaction {
                reason: REASON_PACKAGE_UPGRADED
            },
            "a package-version abort must never be blamed on an innocent blob"
        );
    }

    #[test]
    fn unstructured_and_non_object_failures_are_ambiguous() {
        let status = ExecutionStatus::Failure {
            error: ExecutionError::InsufficientGas,
            command: None,
        };
        assert_eq!(classify_execution_failure(&status), FailureClass::Ambiguous);
    }

    #[test]
    fn shared_object_congestion_is_not_a_toctou_culprit() {
        let status = ExecutionStatus::Failure {
            error: ExecutionError::ExecutionCanceledDueToConsensusObjectCongestion {
                congested_objects: vec!["0x5".parse().unwrap()],
            },
            command: None,
        };
        assert_eq!(
            classify_execution_failure(&status),
            FailureClass::SharedObjectCongestion
        );
    }
}
