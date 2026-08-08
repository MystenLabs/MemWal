use super::{ObjectInfo, SuiApi, SuiErr};
use crate::security_delete_auth::same_owner;
use sui_sdk_types::{Command, Input, Transaction, TransactionKind};

/// The package a prepared deletion transaction actually calls.
///
/// The package id is baked into the PTB's `MoveCall` at prepare time, so a batch prepared
/// before a Walrus upgrade still targets the superseded package. Executing it aborts
/// `EWrongVersion` (`system::inner`, code 1) and can never succeed — so the caller must
/// compare this against the CURRENT on-chain package before spending gas on a retry.
pub fn transaction_package(tx_bytes: &[u8]) -> Result<Option<sui_sdk_types::Address>, String> {
    let transaction: Transaction = bcs::from_bytes(tx_bytes)
        .map_err(|error| format!("prepared batch transaction is invalid: {error}"))?;
    let TransactionKind::ProgrammableTransaction(programmable) = &transaction.kind else {
        return Err("prepared deletion transaction is not programmable".into());
    };
    Ok(programmable
        .commands
        .iter()
        .find_map(|command| match command {
            Command::MoveCall(call) => Some(call.package),
            _ => None,
        }))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StaleInputReason {
    DeletedExternal,
    NotOwner,
    ChangedReference,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StaleInput {
    pub blob_id: String,
    pub reason: StaleInputReason,
}

#[derive(Clone, Debug)]
pub struct ExpectedInput {
    pub blob_id: String,
    object_id: sui_sdk_types::Address,
    version: u64,
    digest: sui_sdk_types::Digest,
}

pub fn expected_inputs(
    tx_bytes: &[u8],
    input_blob_ids: &[String],
) -> Result<Vec<ExpectedInput>, String> {
    let transaction: Transaction = bcs::from_bytes(tx_bytes)
        .map_err(|error| format!("prepared batch transaction is invalid: {error}"))?;
    let TransactionKind::ProgrammableTransaction(programmable) = &transaction.kind else {
        return Err("prepared deletion transaction is not programmable".into());
    };
    let owned = programmable
        .inputs
        .iter()
        .filter_map(|input| match input {
            Input::ImmutableOrOwned(reference) => Some(reference),
            _ => None,
        })
        .collect::<Vec<_>>();
    if owned.len() != input_blob_ids.len() {
        return Err("prepared deletion transaction input count changed".into());
    }
    let expected = input_blob_ids
        .iter()
        .zip(owned)
        .map(|(blob_id, reference)| ExpectedInput {
            blob_id: blob_id.clone(),
            object_id: *reference.object_id(),
            version: reference.version(),
            digest: *reference.digest(),
        })
        .collect::<Vec<_>>();
    Ok(expected)
}

pub fn object_ids(expected: &[ExpectedInput]) -> Vec<String> {
    expected
        .iter()
        .map(|input| input.object_id.to_string())
        .collect()
}

pub async fn fetch_current(
    sui: &dyn SuiApi,
    expected: &[ExpectedInput],
) -> Result<Vec<Option<ObjectInfo>>, SuiErr> {
    let object_ids = object_ids(expected);
    let mut objects = Vec::with_capacity(object_ids.len());
    for chunk in object_ids.chunks(100) {
        objects.extend(sui.batch_get_objects(chunk).await?);
    }
    Ok(objects)
}

pub fn stale_inputs(
    owner: &str,
    expected: &[ExpectedInput],
    current: &[Option<ObjectInfo>],
) -> Result<Vec<StaleInput>, String> {
    if expected.len() != current.len() {
        return Err("Sui object response count changed".into());
    }
    let mut stale = Vec::new();
    for (expected, current) in expected.iter().zip(current) {
        let reason = match current {
            None => Some(StaleInputReason::DeletedExternal),
            Some(object)
                if object.blob_id.as_deref() != Some(expected.blob_id.as_str())
                    || !same_owner(object.owner.as_deref(), owner) =>
            {
                Some(StaleInputReason::NotOwner)
            }
            Some(object) => {
                let object_id_matches = object
                    .object_id
                    .parse::<sui_sdk_types::Address>()
                    .ok()
                    .is_some_and(|object_id| object_id == expected.object_id);
                let digest_matches = object
                    .digest
                    .parse::<sui_sdk_types::Digest>()
                    .ok()
                    .is_some_and(|digest| digest == expected.digest);
                (!object_id_matches || object.version != expected.version || !digest_matches)
                    .then_some(StaleInputReason::ChangedReference)
            }
        };
        if let Some(reason) = reason {
            stale.push(StaleInput {
                blob_id: expected.blob_id.clone(),
                reason,
            });
        }
    }
    Ok(stale)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sui::tx_build::build_delete_tx;
    use crate::sui::SharedObjectInfo;
    use crate::sui::SuiEpoch;
    use crate::sui::WalrusCallPackage;
    use crate::sui::WalrusEpoch;

    /// The Walrus package is baked into the PTB's MoveCall at PREPARE time, and the bytes
    /// are then persisted. If Walrus upgrades before the user signs (up to CLAIM_TTL later),
    /// executing those bytes aborts `EWrongVersion` and can never succeed — so submit and
    /// the reconciler must be able to read the package back out and compare it against the
    /// chain's current one BEFORE spending sponsor gas.
    #[test]
    /// The D3 guard's decision, in one place: a batch prepared before a Walrus upgrade carries
    /// the SUPERSEDED package in its persisted bytes, and submit/reconciler must detect that
    /// BEFORE spending sponsor gas on a transaction that can only abort `EWrongVersion`.
    ///
    /// This is a gas optimisation, not a correctness dependency — if it were removed, the tx
    /// would still abort on chain and `FailureClass::WholeTransaction` would release every row
    /// without evicting any. It exists so we do not pay for that lesson every retry.
    #[test]
    fn a_batch_prepared_before_an_upgrade_is_detectable_from_its_persisted_bytes() {
        const PREPARED_AGAINST: &str = "0xd847"; // the package at prepare time
        const NOW_ON_CHAIN: &str = "0x849e"; // Walrus upgraded since

        let blob = ObjectInfo {
            object_id: "0x01".into(),
            version: 1,
            digest: sui_sdk_types::Digest::new([1; 32]).to_string(),
            owner: Some("0xc8".into()),
            blob_id: Some("blob-0001".into()),
            end_epoch: Some(WalrusEpoch(500)),
            package_id: None,
        };
        let system = SharedObjectInfo {
            object_id: "0xfa".into(),
            initial_shared_version: 7,
            mutable: true,
            package_id: None,
        };
        let built = build_delete_tx(
            "0xc8",
            "0xc9",
            std::slice::from_ref(&blob),
            WalrusCallPackage::from_chain(PREPARED_AGAINST),
            &system,
            SuiEpoch(1159),
            1000,
            10_000_000,
            &[9; 32],
            7,
        )
        .unwrap();

        let baked_in = transaction_package(&built.tx_bytes).unwrap().unwrap();

        // The guard's comparison: parsed addresses, never strings — config may be short-hand
        // while the chain returns canonical 32-byte form, and a string compare would fire on
        // formatting alone, failing every deletion.
        let current: sui_sdk_types::Address = NOW_ON_CHAIN.parse().unwrap();
        assert_ne!(
            baked_in, current,
            "a batch prepared against the old package must be detected as stale"
        );
        assert_eq!(
            baked_in,
            PREPARED_AGAINST.parse::<sui_sdk_types::Address>().unwrap(),
            "the persisted bytes must still name the package they were built against"
        );

        // And the same batch, on a chain that has NOT upgraded, must not trip the guard.
        let unchanged: sui_sdk_types::Address = PREPARED_AGAINST.parse().unwrap();
        assert_eq!(
            baked_in, unchanged,
            "a healthy batch must never be failed by the stale-package guard"
        );
    }

    fn transaction_package_round_trips_the_package_the_tx_will_call() {
        const WALRUS_PACKAGE: &str = "0xca";
        let blob = ObjectInfo {
            object_id: "0x01".into(),
            version: 1,
            digest: sui_sdk_types::Digest::new([1; 32]).to_string(),
            owner: Some("0xc8".into()),
            blob_id: Some("blob-0001".into()),
            end_epoch: Some(WalrusEpoch(500)),
            package_id: None,
        };
        let system = SharedObjectInfo {
            object_id: "0xfa".into(),
            initial_shared_version: 7,
            mutable: true,
            package_id: None,
        };
        let built = build_delete_tx(
            "0xc8",
            "0xc9",
            std::slice::from_ref(&blob),
            WalrusCallPackage::from_chain(WALRUS_PACKAGE),
            &system,
            SuiEpoch(42),
            1000,
            10_000_000,
            &[9; 32],
            7,
        )
        .unwrap();

        let package = transaction_package(&built.tx_bytes).unwrap();
        assert_eq!(
            package,
            Some(WALRUS_PACKAGE.parse().unwrap()),
            "the package must be recoverable from the persisted bytes, or a post-upgrade \
             batch cannot be detected before it burns gas"
        );
        // Addresses, not strings: the chain returns the canonical 32-byte form while config
        // may be short-hand. A string compare would differ on formatting alone and fail
        // EVERY deletion.
        assert_eq!(
            package,
            Some(
                "0x00000000000000000000000000000000000000000000000000000000000000ca"
                    .parse()
                    .unwrap()
            ),
        );
    }
    use sui_sdk_types::Digest;

    fn address(value: u8) -> String {
        format!("0x{value:02x}")
    }

    fn blob(value: u8, owner: &str) -> ObjectInfo {
        ObjectInfo {
            object_id: address(value),
            version: 1,
            digest: Digest::new([value; 32]).to_string(),
            owner: Some(owner.into()),
            blob_id: Some(format!("blob-{value}")),
            end_epoch: Some(WalrusEpoch(500)),
            package_id: None,
        }
    }

    fn fixture() -> (String, Vec<ExpectedInput>, Vec<Option<ObjectInfo>>) {
        let owner = crate::security_delete_auth::canonical_sui_address(&address(200)).unwrap();
        let blobs = vec![blob(1, &owner), blob(2, &owner)];
        let built = build_delete_tx(
            &owner,
            &address(201),
            &blobs,
            WalrusCallPackage::from_chain(&address(202)),
            &SharedObjectInfo {
                object_id: address(203),
                initial_shared_version: 1,
                mutable: true,
                package_id: None,
            },
            SuiEpoch(1),
            1,
            20_000_000,
            &[9; 32],
            7,
        )
        .unwrap();
        let expected = expected_inputs(&built.tx_bytes, &built.input_blob_ids).unwrap();
        (owner, expected, blobs.into_iter().map(Some).collect())
    }

    #[test]
    fn detects_missing_transferred_and_changed_owned_inputs() {
        let (owner, expected, healthy) = fixture();
        assert!(stale_inputs(&owner, &expected, &healthy)
            .unwrap()
            .is_empty());

        let mut missing = healthy.clone();
        missing[0] = None;
        assert_eq!(
            stale_inputs(&owner, &expected, &missing).unwrap()[0].reason,
            StaleInputReason::DeletedExternal
        );

        let mut transferred = healthy.clone();
        transferred[0].as_mut().unwrap().owner = Some(address(55));
        assert_eq!(
            stale_inputs(&owner, &expected, &transferred).unwrap()[0].reason,
            StaleInputReason::NotOwner
        );

        let mut wrong_blob = healthy.clone();
        wrong_blob[0].as_mut().unwrap().blob_id = Some("different-blob".into());
        assert_eq!(
            stale_inputs(&owner, &expected, &wrong_blob).unwrap()[0].reason,
            StaleInputReason::NotOwner
        );

        let mut changed_version = healthy.clone();
        changed_version[0].as_mut().unwrap().version += 1;
        assert_eq!(
            stale_inputs(&owner, &expected, &changed_version).unwrap()[0].reason,
            StaleInputReason::ChangedReference
        );

        let mut changed_digest = healthy;
        changed_digest[0].as_mut().unwrap().digest = Digest::new([44; 32]).to_string();
        assert_eq!(
            stale_inputs(&owner, &expected, &changed_digest).unwrap()[0].reason,
            StaleInputReason::ChangedReference
        );
    }

    #[test]
    fn rejects_malformed_input_counts() {
        let (_, expected, current) = fixture();
        assert!(stale_inputs("0xc8", &expected, &current[..1])
            .unwrap_err()
            .contains("response count"));

        let owner = crate::security_delete_auth::canonical_sui_address(&address(200)).unwrap();
        let blobs = vec![blob(1, &owner), blob(2, &owner)];
        let built = build_delete_tx(
            &owner,
            &address(201),
            &blobs,
            WalrusCallPackage::from_chain(&address(202)),
            &SharedObjectInfo {
                object_id: address(203),
                initial_shared_version: 1,
                mutable: true,
                package_id: None,
            },
            SuiEpoch(1),
            1,
            20_000_000,
            &[9; 32],
            7,
        )
        .unwrap();
        assert!(expected_inputs(&built.tx_bytes, &built.input_blob_ids[..1])
            .unwrap_err()
            .contains("input count"));
    }
}
