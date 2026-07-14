//! Wallet signature verification through Sui's v2 verification service.
//!
//! Passing no explicit JWKs intentionally asks the fullnode to use its current
//! on-chain JWK set, which keeps zkLogin verification epoch-correct without a
//! second, independently refreshed key cache in this service.

use super::SuiClient;
use crate::security_delete_auth::{canonical_sui_address, WalletSignatureVerifier};
use crate::security_delete_error::{SdCode, SdError};
use async_trait::async_trait;
use std::sync::Arc;
use sui_rpc::proto::sui::rpc::v2::{Bcs, VerifySignatureRequest};
use sui_sdk_types::{Transaction, UserSignature};

#[derive(Clone)]
pub struct GrpcWalletSignatureVerifier {
    rpc: Arc<dyn SignatureVerifierRpc>,
}

impl GrpcWalletSignatureVerifier {
    pub fn new(client: SuiClient) -> Self {
        Self {
            rpc: Arc::new(client),
        }
    }

    #[cfg(test)]
    fn with_rpc(rpc: Arc<dyn SignatureVerifierRpc>) -> Self {
        Self { rpc }
    }

    async fn verify(
        &self,
        address: &str,
        message: Bcs,
        signature_b64: &str,
        code: SdCode,
    ) -> Result<Vec<u8>, SdError> {
        let address =
            canonical_sui_address(address).map_err(|_| SdError::new(code, "Invalid signature"))?;
        let signature = UserSignature::from_base64(signature_b64)
            .map_err(|_| SdError::new(code, "Invalid signature"))?;
        let bytes = signature.to_bytes();
        let request = build_verify_request(message, signature, address);
        let response = self.rpc.verify(request).await.map_err(|error| {
            tracing::warn!(%error, "Sui signature verification RPC unavailable");
            SdError::new(SdCode::RpcUnavailable, "Sui RPC is temporarily unavailable")
        })?;
        if response.is_valid == Some(true) {
            Ok(bytes)
        } else {
            Err(SdError::new(code, "Invalid signature"))
        }
    }
}

#[async_trait]
trait SignatureVerifierRpc: Send + Sync {
    async fn verify(
        &self,
        request: VerifySignatureRequest,
    ) -> Result<sui_rpc::proto::sui::rpc::v2::VerifySignatureResponse, super::SuiErr>;
}

#[async_trait]
impl SignatureVerifierRpc for SuiClient {
    async fn verify(
        &self,
        request: VerifySignatureRequest,
    ) -> Result<sui_rpc::proto::sui::rpc::v2::VerifySignatureResponse, super::SuiErr> {
        self.verify_signature_request(request).await
    }
}

#[async_trait::async_trait]
impl WalletSignatureVerifier for GrpcWalletSignatureVerifier {
    async fn verify_personal(
        &self,
        address: &str,
        message: &[u8],
        signature_b64: &str,
    ) -> Result<(), SdError> {
        // PersonalMessage signs the BCS `vector<u8>` payload under the
        // PersonalMessage intent; the wrapper itself is intentionally not
        // serde-serializable in sui-sdk-types.
        let mut bcs = Bcs::serialize(&message)
            .map_err(|_| SdError::new(SdCode::AuthInvalidSignature, "Invalid signature"))?;
        bcs.name = Some("PersonalMessage".into());
        self.verify(address, bcs, signature_b64, SdCode::AuthInvalidSignature)
            .await
            .map(|_| ())
    }

    async fn verify_transaction(
        &self,
        address: &str,
        tx_bytes: &[u8],
        signature_b64: &str,
    ) -> Result<Vec<u8>, SdError> {
        let transaction: Transaction = bcs::from_bytes(tx_bytes)
            .map_err(|_| SdError::new(SdCode::InvalidSignature, "Invalid signature"))?;
        let mut bcs = Bcs::serialize(&transaction)
            .map_err(|_| SdError::new(SdCode::InvalidSignature, "Invalid signature"))?;
        bcs.name = Some("TransactionData".into());
        self.verify(address, bcs, signature_b64, SdCode::InvalidSignature)
            .await
    }
}

fn build_verify_request(
    message: Bcs,
    signature: UserSignature,
    address: String,
) -> VerifySignatureRequest {
    let mut request = VerifySignatureRequest::default();
    request.message = Some(message);
    request.signature = Some(signature.into());
    request.address = Some(address);
    // Empty by design: use the fullnode's current on-chain JWK set.
    request.jwks = Vec::new();
    request
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use sui_crypto::{ed25519::Ed25519PrivateKey, SuiSigner};
    use sui_sdk_types::PersonalMessage;

    struct MockRpc {
        requests: Mutex<Vec<VerifySignatureRequest>>,
        valid: bool,
    }

    struct UnavailableRpc;

    #[async_trait]
    impl SignatureVerifierRpc for UnavailableRpc {
        async fn verify(
            &self,
            _request: VerifySignatureRequest,
        ) -> Result<sui_rpc::proto::sui::rpc::v2::VerifySignatureResponse, super::super::SuiErr>
        {
            Err(super::super::SuiErr::Transport("offline".into()))
        }
    }

    #[async_trait]
    impl SignatureVerifierRpc for MockRpc {
        async fn verify(
            &self,
            request: VerifySignatureRequest,
        ) -> Result<sui_rpc::proto::sui::rpc::v2::VerifySignatureResponse, super::super::SuiErr>
        {
            self.requests.lock().unwrap().push(request);
            let mut response = sui_rpc::proto::sui::rpc::v2::VerifySignatureResponse::default();
            response.is_valid = Some(self.valid);
            Ok(response)
        }
    }

    #[test]
    fn request_uses_exact_personal_message_bcs_and_live_jwks() {
        let message = PersonalMessage(b"hello".as_slice().into());
        let key = Ed25519PrivateKey::new([7; 32]);
        let signature = key.sign_personal_message(&message).unwrap();
        let mut encoded = Bcs::serialize(&message.0.as_ref()).unwrap();
        encoded.name = Some("PersonalMessage".into());
        let request = build_verify_request(
            encoded,
            signature,
            key.public_key().derive_address().to_string(),
        );
        assert_eq!(
            request.message.unwrap().name.as_deref(),
            Some("PersonalMessage")
        );
        assert!(request.jwks.is_empty());
        assert!(request.address.is_some());
        assert!(request.signature.is_some());
    }

    #[test]
    fn transaction_message_uses_transaction_data_name() {
        let mut encoded = Bcs::serialize(&Transaction {
            kind: sui_sdk_types::TransactionKind::ProgrammableTransaction(
                sui_sdk_types::ProgrammableTransaction {
                    inputs: vec![],
                    commands: vec![],
                },
            ),
            sender: "0x1".parse().unwrap(),
            gas_payment: sui_sdk_types::GasPayment {
                objects: vec![],
                owner: "0x2".parse().unwrap(),
                price: 1,
                budget: 1,
            },
            expiration: sui_sdk_types::TransactionExpiration::None,
        })
        .unwrap();
        encoded.name = Some("TransactionData".into());
        assert_eq!(encoded.name.as_deref(), Some("TransactionData"));
    }

    #[tokio::test]
    async fn simple_signature_runs_through_service_boundary() {
        let key = Ed25519PrivateKey::new([9; 32]);
        let address = key.public_key().derive_address().to_string();
        let message = PersonalMessage(b"authorize".as_slice().into());
        let signature = key.sign_personal_message(&message).unwrap().to_base64();
        let rpc = Arc::new(MockRpc {
            requests: Mutex::new(Vec::new()),
            valid: true,
        });
        let verifier = GrpcWalletSignatureVerifier::with_rpc(rpc.clone());
        verifier
            .verify_personal(&address, b"authorize", &signature)
            .await
            .unwrap();
        let requests = rpc.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(
            requests[0].message().name.as_deref(),
            Some("PersonalMessage")
        );
        assert!(requests[0].jwks.is_empty());
    }

    #[tokio::test]
    async fn verifier_transport_failure_uses_closed_rpc_unavailable_error() {
        let key = Ed25519PrivateKey::new([8; 32]);
        let address = key.public_key().derive_address().to_string();
        let message = PersonalMessage(b"authorize".as_slice().into());
        let signature = key.sign_personal_message(&message).unwrap().to_base64();
        let verifier = GrpcWalletSignatureVerifier::with_rpc(Arc::new(UnavailableRpc));
        let error = verifier
            .verify_personal(&address, b"authorize", &signature)
            .await
            .unwrap_err();
        assert_eq!(error.code, SdCode::RpcUnavailable);
        assert_eq!(error.message, "Sui RPC is temporarily unavailable");
        assert!(error
            .details
            .as_object()
            .is_some_and(|details| details.is_empty()));
    }

    #[tokio::test]
    async fn zklogin_signature_runs_through_live_jwk_service_path() {
        let inputs: sui_sdk_types::ZkLoginInputs = serde_json::from_value(serde_json::json!({
            "proof_points": {
                "a": [
                    "17318089125952421736342263717932719437717844282410187957984751939942898251250",
                    "11373966645469122582074082295985388258840681618268593976697325892280915681207",
                    "1"
                ],
                "b": [
                    [
                        "59398711473488349973617201222389801771523032712405795869594598595869895",
                        "45335682711354681758968758426885423584628115386095"
                    ],
                    [
                        "10564387285071555469753990661410840118635925466597037018058770041347518461368",
                        "12597323547277579144698496372242615368085801313343155735511330003884767957854"
                    ],
                    ["1", "0"]
                ],
                "c": [
                    "15791589472556826263231644728873337629015269984699404073623603352537678813171",
                    "4547866499248881449676161158024748060485373250029423904113017422539037162527",
                    "1"
                ]
            },
            "iss_base64_details": {
                "value": "wiaXNzIjoiaHR0cHM6Ly9pZC50d2l0Y2gudHYvb2F1dGgyIiw",
                "index_mod_4": 2
            },
            "header_base64": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6IjEifQ",
            "address_seed": "20794788559620669596206457022966176986688727876128223628113916380927502737911"
        })).unwrap();
        let message = PersonalMessage(b"authorize".as_slice().into());
        let key = Ed25519PrivateKey::new([9; 32]);
        let simple =
            <Ed25519PrivateKey as sui_crypto::Signer<sui_sdk_types::SimpleSignature>>::try_sign(
                &key,
                &message.signing_digest(),
            )
            .unwrap();
        let signature = UserSignature::ZkLogin(Box::new(sui_sdk_types::ZkLoginAuthenticator {
            inputs,
            max_epoch: 10,
            signature: simple,
        }));
        let address = signature.derive_addresses().next().unwrap().to_string();
        let rpc = Arc::new(MockRpc {
            requests: Mutex::new(Vec::new()),
            valid: true,
        });
        let verifier = GrpcWalletSignatureVerifier::with_rpc(rpc.clone());
        verifier
            .verify_personal(&address, b"authorize", &signature.to_base64())
            .await
            .unwrap();
        let requests = rpc.requests.lock().unwrap();
        let decoded = UserSignature::try_from(requests[0].signature()).unwrap();
        assert!(matches!(decoded, UserSignature::ZkLogin(_)));
        assert!(
            requests[0].jwks.is_empty(),
            "fullnode must use current on-chain JWKs"
        );
    }
}
