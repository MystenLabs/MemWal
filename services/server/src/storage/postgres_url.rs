//! Postgres URL helpers for pooled vs direct endpoints.
//!
//! sqlx migrations take a **session-scoped** `pg_advisory_lock`. A
//! transaction-mode pooler (Neon `-pooler`, PgBouncer) can route `LOCK` and
//! `UNLOCK` to different backends, or return a backend to the pool with the
//! lock still held after the client disconnects. The next boot then waits on
//! that lock, inherits a leaked `lock_timeout`, and panics.
//!
//! Migrations must run against the direct compute endpoint. Runtime query
//! pools may keep the pooled URL.

use std::borrow::Cow;

/// True when `url` points at a transaction-mode pooler hostname.
///
/// Neon names these `*-pooler.*` (e.g. `ep-foo-pooler.c-2.aws.neon.tech`).
pub fn is_transaction_pooler_url(url: &str) -> bool {
    postgres_host(url).is_some_and(|host| host.contains("-pooler."))
}

/// Rewrite a Neon/PgBouncer pooled URL to the direct compute hostname.
///
/// Leaves already-direct URLs, unparseable strings, and unix sockets
/// unchanged. Credentials and query params are preserved.
pub fn direct_postgres_url(url: &str) -> Cow<'_, str> {
    let Ok(mut parsed) = url::Url::parse(url) else {
        return Cow::Borrowed(url);
    };
    let Some(host) = parsed.host_str() else {
        return Cow::Borrowed(url);
    };
    if !host.contains("-pooler.") {
        return Cow::Borrowed(url);
    }
    let direct_host = host.replace("-pooler.", ".");
    if parsed.set_host(Some(&direct_host)).is_err() {
        return Cow::Borrowed(url);
    }
    Cow::Owned(parsed.to_string())
}

pub(crate) fn postgres_host(url: &str) -> Option<String> {
    url::Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(str::to_owned))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn neon_pooler_host_rewrites_to_direct() {
        let pooled = "postgresql://memwal:s3cret@ep-odd-cake-aorg5ujz-pooler.c-2.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require";
        let direct = direct_postgres_url(pooled);
        assert_eq!(
            url::Url::parse(&direct).unwrap().host_str(),
            Some("ep-odd-cake-aorg5ujz.c-2.ap-southeast-1.aws.neon.tech")
        );
        assert!(direct.contains("sslmode=require"));
        assert!(direct.contains("channel_binding=require"));
        assert!(direct.contains("memwal:s3cret"));
        assert!(
            direct.ends_with("/neondb?sslmode=require&channel_binding=require")
                || direct.contains("/neondb?")
        );
        assert!(is_transaction_pooler_url(pooled));
        assert!(!is_transaction_pooler_url(&direct));
    }

    #[test]
    fn already_direct_url_is_unchanged() {
        let url = "postgresql://memwal:s3cret@ep-odd-cake-aorg5ujz.c-2.ap-southeast-1.aws.neon.tech/neondb";
        assert!(matches!(direct_postgres_url(url), Cow::Borrowed(_)));
        assert!(!is_transaction_pooler_url(url));
    }

    #[test]
    fn pooler_in_user_or_db_name_is_not_rewritten() {
        let url = "postgresql://pooler-user:x@localhost:5432/pooler";
        assert!(matches!(direct_postgres_url(url), Cow::Borrowed(_)));
        assert!(!is_transaction_pooler_url(url));
    }

    #[test]
    fn percent_encoded_password_survives_rewrite() {
        let pooled = "postgresql://memwal:p%40ss@ep-foo-pooler.us-east-2.aws.neon.tech/neondb";
        let direct = direct_postgres_url(pooled);
        let parsed = url::Url::parse(&direct).unwrap();
        assert_eq!(parsed.password(), Some("p%40ss"));
        assert_eq!(parsed.host_str(), Some("ep-foo.us-east-2.aws.neon.tech"));
    }

    #[test]
    fn unparseable_or_socket_urls_pass_through() {
        assert!(matches!(
            direct_postgres_url("not a url"),
            Cow::Borrowed("not a url")
        ));
        let socket = "postgresql://memwal@/neondb?host=/tmp";
        // url crate may or may not treat this as host-less; either way we
        // must not panic or invent a hostname.
        let _ = direct_postgres_url(socket);
        assert!(!is_transaction_pooler_url(socket));
    }
}
