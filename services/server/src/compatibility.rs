//! Public relayer/API compatibility metadata.
//!
//! These constants are part of the relayer contract. Keep them in sync with
//! docs/relayer/versioning-and-compatibility.md and the SDK compatibility
//! guards; scripts/check-compatibility-contract.mjs verifies that in CI.

use serde::Serialize;
use std::collections::BTreeMap;

pub const RELAYER_API_VERSION: &str = "1.0.0";
pub const MIN_TYPESCRIPT_SDK_VERSION: &str = "0.0.4";
pub const MIN_PYTHON_SDK_VERSION: &str = "0.1.0";
pub const MIN_MCP_PACKAGE_VERSION: &str = "0.0.1";

#[derive(Debug, Clone, Serialize)]
pub struct VersionResponse {
    #[serde(rename = "relayerVersion")]
    pub relayer_version: String,
    #[serde(rename = "apiVersion")]
    pub api_version: String,
    #[serde(rename = "minSupportedSdk")]
    pub min_supported_sdk: MinSupportedSdk,
    #[serde(rename = "featureFlags")]
    pub feature_flags: BTreeMap<String, bool>,
    pub deprecations: Vec<DeprecationNotice>,
    pub build: BuildMetadata,
}

#[derive(Debug, Clone, Serialize)]
pub struct MinSupportedSdk {
    pub typescript: String,
    pub python: String,
    pub mcp: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeprecationNotice {
    pub surface: String,
    #[serde(rename = "deprecatedSince")]
    pub deprecated_since: String,
    #[serde(rename = "removalApiVersion")]
    pub removal_api_version: String,
    pub guidance: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct BuildMetadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
    #[serde(rename = "buildTimestamp", skip_serializing_if = "Option::is_none")]
    pub build_timestamp: Option<String>,
}

pub fn version_response() -> VersionResponse {
    VersionResponse {
        relayer_version: env!("CARGO_PKG_VERSION").to_string(),
        api_version: RELAYER_API_VERSION.to_string(),
        min_supported_sdk: MinSupportedSdk {
            typescript: MIN_TYPESCRIPT_SDK_VERSION.to_string(),
            python: MIN_PYTHON_SDK_VERSION.to_string(),
            mcp: MIN_MCP_PACKAGE_VERSION.to_string(),
        },
        feature_flags: feature_flags(),
        deprecations: deprecations(),
        build: BuildMetadata {
            commit: first_metadata_value(&[
                option_env!("GIT_SHA"),
                option_env!("GITHUB_SHA"),
                option_env!("RAILWAY_GIT_COMMIT_SHA"),
            ])
            .or_else(|| first_runtime_env(&["GIT_SHA", "GITHUB_SHA", "RAILWAY_GIT_COMMIT_SHA"])),
            build_timestamp: first_metadata_value(&[
                option_env!("BUILD_TIMESTAMP"),
                option_env!("SOURCE_DATE_EPOCH"),
            ])
            .or_else(|| first_runtime_env(&["BUILD_TIMESTAMP", "SOURCE_DATE_EPOCH"])),
        },
    }
}

fn feature_flags() -> BTreeMap<String, bool> {
    BTreeMap::from([
        ("auth.accountBoundNonce".to_string(), true),
        ("auth.sealSessionHeader".to_string(), true),
        ("config.publicDeploymentMetadata".to_string(), true),
        ("remember.asyncJobs".to_string(), true),
        ("remember.bulk".to_string(), true),
        ("runtime.versionEndpoint".to_string(), true),
    ])
}

fn deprecations() -> Vec<DeprecationNotice> {
    vec![
        DeprecationNotice {
            surface: "header:x-delegate-key".to_string(),
            deprecated_since: "1.0.0".to_string(),
            removal_api_version: "2.0.0".to_string(),
            guidance: "Use x-seal-session for relayer-managed SEAL decrypt flows; manual-mode requests should send no decrypt credential.".to_string(),
        },
        DeprecationNotice {
            surface: "env:SEAL_KEY_SERVERS".to_string(),
            deprecated_since: "1.0.0".to_string(),
            removal_api_version: "2.0.0".to_string(),
            guidance: "Use SEAL_SERVER_CONFIGS so independent and committee key-server configs share one JSON schema.".to_string(),
        },
    ]
}

fn first_metadata_value(values: &[Option<&'static str>]) -> Option<String> {
    values
        .iter()
        .flatten()
        .map(|value| value.trim())
        .find(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn first_runtime_env(names: &[&str]) -> Option<String> {
    names
        .iter()
        .filter_map(|name| std::env::var(name).ok())
        .map(|value| value.trim().to_string())
        .find(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::{
        version_response, MIN_MCP_PACKAGE_VERSION, MIN_PYTHON_SDK_VERSION,
        MIN_TYPESCRIPT_SDK_VERSION, RELAYER_API_VERSION,
    };

    #[test]
    fn version_response_exposes_contract_metadata() {
        let response = version_response();

        assert_eq!(response.relayer_version, env!("CARGO_PKG_VERSION"));
        assert_eq!(response.api_version, RELAYER_API_VERSION);
        assert_eq!(
            response.min_supported_sdk.typescript,
            MIN_TYPESCRIPT_SDK_VERSION
        );
        assert_eq!(response.min_supported_sdk.python, MIN_PYTHON_SDK_VERSION);
        assert_eq!(response.min_supported_sdk.mcp, MIN_MCP_PACKAGE_VERSION);
        assert_eq!(
            response.feature_flags.get("runtime.versionEndpoint"),
            Some(&true)
        );
        assert!(response
            .deprecations
            .iter()
            .any(|notice| notice.surface == "header:x-delegate-key"));
    }
}
