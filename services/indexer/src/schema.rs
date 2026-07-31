diesel::table! {
    accounts (account_id) {
        account_id -> Text,
        owner -> Text,
        created_at -> Timestamptz,
    }
}
