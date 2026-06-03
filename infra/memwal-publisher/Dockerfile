FROM rust:1-bookworm AS builder
WORKDIR /app
COPY Cargo.toml Cargo.lock* ./
COPY src ./src
RUN cargo build --release

FROM cmdoss/walrus:v0.1.1
COPY --from=builder /app/target/release/memwal-publisher /usr/local/bin/memwal-publisher
COPY entrypoint.sh /memwal-entrypoint.sh
RUN chmod +x /memwal-entrypoint.sh
ENTRYPOINT ["/memwal-entrypoint.sh"]
