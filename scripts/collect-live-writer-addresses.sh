#!/usr/bin/env bash
set -euo pipefail

collector_self_test() (
    command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

    test_root="$(mktemp -d)"
    trap 'rm -rf "$test_root"' EXIT
    fixture_dir="$test_root/fixtures"
    mock_bin="$test_root/bin"
    mkdir -p "$fixture_dir" "$mock_bin"

    jq -n '{
        metadata: {uid: "statefulset-uid", generation: 3},
        spec: {
            replicas: 1,
            template: {spec: {containers: [{
                name: "migrator",
                envFrom: [{secretRef: {name: "writer-wallets"}}]
            }]}}
        },
        status: {
            observedGeneration: 3,
            currentRevision: "writer-revision-3",
            updateRevision: "writer-revision-3",
            currentReplicas: 1,
            updatedReplicas: 1,
            readyReplicas: 1
        }
    }' >"$fixture_dir/statefulset.json"
    jq -n '{
        metadata: {
            name: "walrus-memory-migration-writer-0",
            uid: "pod-uid-0",
            deletionTimestamp: null,
            labels: {"controller-revision-hash": "writer-revision-3"},
            ownerReferences: [{
                kind: "StatefulSet",
                uid: "statefulset-uid",
                controller: true
            }]
        },
        status: {
            conditions: [{type: "Ready", status: "True"}],
            containerStatuses: [{
                name: "migrator",
                ready: true,
                image: "registry.example/migrator:sha",
                imageID: "registry.example/migrator@sha256:abc"
            }]
        }
    }' >"$fixture_dir/pod.json"
    for secret in writer-wallets writer-wallets-a writer-wallets-b; do
        jq -n --arg name "$secret" '{
            metadata: {
                name: $name,
                uid: ($name + "-uid"),
                resourceVersion: "123"
            },
            immutable: true,
            data: {SERVER_SUI_PRIVATE_KEYS: "dGVzdA=="}
        }' >"$fixture_dir/secret-$secret.json"
    done
    jq -n '["0x1111111111111111111111111111111111111111111111111111111111111111"]' \
        >"$fixture_dir/addresses.json"

    cat >"$mock_bin/kubectl" <<'MOCK_KUBECTL'
#!/usr/bin/env bash
set -euo pipefail

scenario="${COLLECTOR_SCENARIO:-healthy}"
joined=" $* "

case "$joined" in
    *" config current-context "*)
        echo fixture-context
        ;;
    *" get statefulset "*)
        case "$scenario" in
            incomplete-rollout)
                jq '.status.updatedReplicas = 0' "$COLLECTOR_FIXTURE_DIR/statefulset.json"
                ;;
            ambiguous-provider)
                jq '.spec.template.spec.containers[0].envFrom = [
                    {secretRef: {name: "writer-wallets-a"}},
                    {secretRef: {name: "writer-wallets-b"}}
                ]' "$COLLECTOR_FIXTURE_DIR/statefulset.json"
                ;;
            *)
                jq '.' "$COLLECTOR_FIXTURE_DIR/statefulset.json"
                ;;
        esac
        ;;
    *" get secret/"*)
        secret_name=""
        for arg in "$@"; do
            case "$arg" in
                secret/*) secret_name="${arg#secret/}" ;;
            esac
        done
        [[ -n "$secret_name" ]]
        if [[ "$scenario" == "mutable-secret" ]]; then
            jq '.immutable = false' "$COLLECTOR_FIXTURE_DIR/secret-$secret_name.json"
        else
            jq '.' "$COLLECTOR_FIXTURE_DIR/secret-$secret_name.json"
        fi
        ;;
    *" wait "*)
        ;;
    *" get pod/"*)
        count_file="$COLLECTOR_FIXTURE_DIR/pod-read-count"
        count=0
        if [[ -f "$count_file" ]]; then
            read -r count <"$count_file"
        fi
        printf '%s\n' "$((count + 1))" >"$count_file"
        if [[ "$count" -gt 0 && "$scenario" == "pod-uid-change" ]]; then
            jq '.metadata.uid = "replacement-pod-uid"' "$COLLECTOR_FIXTURE_DIR/pod.json"
        elif [[ "$count" -gt 0 && "$scenario" == "pod-image-change" ]]; then
            jq '.status.containerStatuses[0].imageID = "registry.example/migrator@sha256:def"' \
                "$COLLECTOR_FIXTURE_DIR/pod.json"
        else
            jq '.' "$COLLECTOR_FIXTURE_DIR/pod.json"
        fi
        ;;
    *" exec "*)
        jq -c '.' "$COLLECTOR_FIXTURE_DIR/addresses.json"
        ;;
    *)
        echo "unexpected mocked kubectl invocation: $*" >&2
        exit 2
        ;;
esac
MOCK_KUBECTL
    chmod +x "$mock_bin/kubectl"

    script_path="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/$(basename -- "${BASH_SOURCE[0]}")"
    rm -f "$fixture_dir/pod-read-count"
    PATH="$mock_bin:$PATH" \
        COLLECTOR_FIXTURE_DIR="$fixture_dir" \
        COLLECTOR_SCENARIO=healthy \
        "$script_path" fixture fixture-context >"$test_root/healthy.json"
    jq -e '
        .schemaVersion == 1
        and .statefulSet.replicas == 1
        and .writerSecrets == [{
            name: "writer-wallets",
            uid: "writer-wallets-uid",
            resourceVersion: "123",
            immutable: true
        }]
        and .writerSecretProviders == [{
            container: "migrator",
            secretName: "writer-wallets",
            key: "SERVER_SUI_PRIVATE_KEYS",
            source: "envFrom"
        }]
        and (.writers | length) == 1
        and .writers[0].podUid == "pod-uid-0"
        and .writers[0].images[0].imageId == "registry.example/migrator@sha256:abc"
    ' "$test_root/healthy.json" >/dev/null

    for scenario in mutable-secret ambiguous-provider incomplete-rollout pod-uid-change pod-image-change; do
        rm -f "$fixture_dir/pod-read-count"
        if PATH="$mock_bin:$PATH" \
            COLLECTOR_FIXTURE_DIR="$fixture_dir" \
            COLLECTOR_SCENARIO="$scenario" \
            "$script_path" fixture fixture-context >/dev/null 2>&1; then
            echo "collector self-test failed: $scenario was accepted" >&2
            exit 1
        fi
    done

    echo "collector self-test OK"
)

if [[ "${1:-}" == "--self-test" ]]; then
    collector_self_test
    exit
fi

namespace="${1:?usage: collect-live-writer-addresses.sh NAMESPACE [KUBE_CONTEXT]}"
context="${2:-}"
statefulset="${WRITER_STATEFULSET:-walrus-memory-migration-writer}"

command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
command -v kubectl >/dev/null || { echo "kubectl is required" >&2; exit 1; }

if [[ -z "$context" ]]; then
    context="$(kubectl config current-context)"
fi
if [[ -z "$context" ]]; then
    echo "Kubernetes context must not be empty" >&2
    exit 1
fi
kubectl_args=(--context "$context" --request-timeout=10s)

statefulset_json() {
    kubectl "${kubectl_args[@]}" -n "$namespace" get statefulset "$statefulset" -o json
}

snapshot_identity() {
    jq -c '{
        uid: .metadata.uid,
        generation: .metadata.generation,
        observedGeneration: (.status.observedGeneration // 0),
        revision: .status.currentRevision,
        updateRevision: .status.updateRevision,
        replicas: .spec.replicas,
        currentReplicas: (.status.currentReplicas // 0),
        updatedReplicas: (.status.updatedReplicas // 0),
        readyReplicas: (.status.readyReplicas // 0)
    }'
}

before="$(statefulset_json)"
uid="$(jq -er '.metadata.uid | select(type == "string" and length > 0)' <<<"$before")"
generation="$(jq -er '.metadata.generation | select(type == "number")' <<<"$before")"
observed_generation="$(jq -er '.status.observedGeneration // 0' <<<"$before")"
revision="$(jq -er '.status.currentRevision | select(type == "string" and length > 0)' <<<"$before")"
update_revision="$(jq -er '.status.updateRevision | select(type == "string" and length > 0)' <<<"$before")"
replicas="$(jq -er '.spec.replicas | select(type == "number")' <<<"$before")"
current_replicas="$(jq -er '.status.currentReplicas // 0' <<<"$before")"
updated_replicas="$(jq -er '.status.updatedReplicas // 0' <<<"$before")"
ready_replicas="$(jq -er '.status.readyReplicas // 0' <<<"$before")"

for value in "$generation" "$observed_generation" "$replicas" "$current_replicas" "$updated_replicas" "$ready_replicas"; do
    if [[ ! "$value" =~ ^[0-9]+$ ]]; then
        echo "$statefulset has invalid numeric rollout metadata" >&2
        exit 1
    fi
done
if ((replicas < 1)); then
    echo "$statefulset must have at least one replica" >&2
    exit 1
fi
if ((observed_generation < generation)); then
    echo "$statefulset controller has not observed generation $generation" >&2
    exit 1
fi
if [[ "$revision" != "$update_revision" ]] \
    || ((current_replicas != replicas)) \
    || ((updated_replicas != replicas)) \
    || ((ready_replicas != replicas)); then
    echo "$statefulset rollout is not complete ($current_replicas current, $updated_replicas updated, $ready_replicas/$replicas ready, $revision -> $update_revision)" >&2
    exit 1
fi

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

referenced_secret_names="$(
    jq -c '[
        (.spec.template.spec.containers[]? |
            (.env[]? | select(.name == "SERVER_SUI_PRIVATE_KEYS") |
                .valueFrom.secretKeyRef.name // empty),
            (.envFrom[]? | select((.prefix // "") == "") |
                .secretRef.name // empty))
    ] | unique' <<<"$before"
)"
referenced_secret_count="$(jq -r 'length' <<<"$referenced_secret_names")"
for ((index = 0; index < referenced_secret_count; index++)); do
    secret="$(jq -r ".[${index}]" <<<"$referenced_secret_names")"
    secret_json="$(kubectl "${kubectl_args[@]}" -n "$namespace" get "secret/$secret" -o json)"
    jq -c '{
        name: .metadata.name,
        uid: .metadata.uid,
        resourceVersion: .metadata.resourceVersion,
        immutable: (.immutable == true),
        keys: ((.data // {}) | keys)
    }' <<<"$secret_json" >"$tmpdir/candidate-secret-$index.json"
done
if ((referenced_secret_count > 0)); then
    secret_inventory="$(jq -s '.' "$tmpdir"/candidate-secret-*.json)"
else
    secret_inventory='[]'
fi

if ! writer_secret_providers="$(
    jq -ce --argjson secrets "$secret_inventory" '
        def find_secret($name):
            ([$secrets[] | select(.name == $name)][0]
                // error("referenced Secret " + ($name // "<missing>") + " was not loaded"));
        [
            .spec.template.spec.containers[] |
            . as $container |
            ([$container.env[]? | select(.name == "SERVER_SUI_PRIVATE_KEYS")]) as $explicit |
            if ($explicit | length) > 1 then
                error($container.name + " declares SERVER_SUI_PRIVATE_KEYS more than once")
            elif ($explicit | length) == 1 then
                ($explicit[0].valueFrom.secretKeyRef
                    // error($container.name + " must source SERVER_SUI_PRIVATE_KEYS from a Secret")) as $ref |
                (find_secret($ref.name)) as $secret |
                if ($secret.keys | index($ref.key)) == null then
                    error($secret.name + " does not contain key " + ($ref.key // "<missing>"))
                else {
                    container: $container.name,
                    secretName: $secret.name,
                    key: $ref.key,
                    source: "secretKeyRef",
                    uid: $secret.uid,
                    resourceVersion: $secret.resourceVersion,
                    immutable: $secret.immutable
                } end
            else
                [
                    $container.envFrom[]? |
                    select((.prefix // "") == "") |
                    (.secretRef.name // empty) as $name |
                    (find_secret($name)) as $secret |
                    select($secret.keys | index("SERVER_SUI_PRIVATE_KEYS") != null) |
                    {
                        container: $container.name,
                        secretName: $secret.name,
                        key: "SERVER_SUI_PRIVATE_KEYS",
                        source: "envFrom",
                        uid: $secret.uid,
                        resourceVersion: $secret.resourceVersion,
                        immutable: $secret.immutable
                    }
                ] as $providers |
                if ($providers | length) > 1 then
                    error($container.name + " has ambiguous envFrom providers for SERVER_SUI_PRIVATE_KEYS")
                elif ($providers | length) == 1 then $providers[0]
                else empty end
            end
        ] as $providers |
        if ($providers | length) == 0 then
            error("no writer container has a Secret-backed SERVER_SUI_PRIVATE_KEYS")
        elif any($providers[]; .immutable != true) then
            error("the Secret providing SERVER_SUI_PRIVATE_KEYS is mutable")
        else $providers end
    ' <<<"$before"
)"; then
    echo "cannot prove writer keys are supplied by exact immutable Secrets; create immutable replacement Secret(s), update the StatefulSet, and roll it before collecting addresses" >&2
    exit 1
fi

writer_secrets="$(
    jq -c '[.[] | {
        name: .secretName,
        uid,
        resourceVersion,
        immutable
    }] | unique_by(.name) | sort_by(.name)' <<<"$writer_secret_providers"
)"
writer_secret_bindings="$(
    jq -c '[.[] | {
        container,
        secretName,
        key,
        source
    }] | sort_by(.container)' <<<"$writer_secret_providers"
)"
secret_count="$(jq -r 'length' <<<"$writer_secrets")"
for ((index = 0; index < secret_count; index++)); do
    jq -c ".[${index}]" <<<"$writer_secrets" >"$tmpdir/secret-$index.json"
done

for ((ordinal = 0; ordinal < replicas; ordinal++)); do
    pod="$statefulset-$ordinal"
    kubectl "${kubectl_args[@]}" -n "$namespace" wait --for=condition=Ready "pod/$pod" --timeout=5s >/dev/null
    pod_json="$(kubectl "${kubectl_args[@]}" -n "$namespace" get "pod/$pod" -o json)"
    if ! jq -e \
        --arg pod "$pod" \
        --arg uid "$uid" \
        --arg revision "$revision" \
        '.metadata.name == $pod
         and .metadata.deletionTimestamp == null
         and .metadata.labels["controller-revision-hash"] == $revision
         and any(.metadata.ownerReferences[]?;
             .kind == "StatefulSet" and .uid == $uid and .controller == true)
         and any(.status.conditions[]?; .type == "Ready" and .status == "True")
         and (.status.containerStatuses | type == "array" and length > 0
             and all(.[]; .ready == true and (.imageID | type == "string" and length > 0)))' \
        <<<"$pod_json" >/dev/null; then
        echo "$pod is not owned by StatefulSet $statefulset revision $revision" >&2
        exit 1
    fi
    pod_uid="$(jq -er '.metadata.uid | select(type == "string" and length > 0)' <<<"$pod_json")"
    images="$(
        jq -c '[.status.containerStatuses | sort_by(.name)[] |
            {name: .name, image: .image, imageId: .imageID}]' <<<"$pod_json"
    )"
    addresses="$({
        # shellcheck disable=SC2016 # The single-quoted program runs inside Node.
        kubectl "${kubectl_args[@]}" -n "$namespace" exec "$pod" -- node -e '
            fetch("http://127.0.0.1:9000/ready", { signal: AbortSignal.timeout(5000) })
                .then(async (response) => {
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    const body = await response.json();
                    if (!Array.isArray(body.serverKeyAddresses) || body.serverKeyAddresses.length === 0) {
                        throw new Error("missing serverKeyAddresses");
                    }
                    process.stdout.write(JSON.stringify(body.serverKeyAddresses));
                })
                .catch((error) => { console.error(error); process.exit(1); });
        '
    })"
    if ! jq -e 'type == "array" and length > 0 and all(.[]; type == "string" and length > 0)' <<<"$addresses" >/dev/null; then
        echo "$pod returned invalid serverKeyAddresses" >&2
        exit 1
    fi
    jq -cn \
        --arg id "$pod" \
        --argjson ordinal "$ordinal" \
        --arg podUid "$pod_uid" \
        --arg revision "$revision" \
        --argjson images "$images" \
        --argjson addresses "$addresses" \
        '{id: $id, ordinal: $ordinal, podUid: $podUid, revision: $revision, images: $images, addresses: $addresses}' \
        >"$tmpdir/writer-$ordinal.json"
done

after="$(statefulset_json)"
if [[ "$(snapshot_identity <<<"$before")" != "$(snapshot_identity <<<"$after")" ]]; then
    echo "$statefulset changed while writer addresses were collected; collect again" >&2
    exit 1
fi
for ((index = 0; index < secret_count; index++)); do
    secret="$(jq -r '.name' "$tmpdir/secret-$index.json")"
    current_secret="$(kubectl "${kubectl_args[@]}" -n "$namespace" get "secret/$secret" -o json)"
    current_identity="$(
        jq -c '{
            name: .metadata.name,
            uid: .metadata.uid,
            resourceVersion: .metadata.resourceVersion,
            immutable: (.immutable == true)
        }' <<<"$current_secret"
    )"
    if [[ "$current_identity" != "$(<"$tmpdir/secret-$index.json")" ]]; then
        echo "writer Secret $secret changed while addresses were collected; collect again" >&2
        exit 1
    fi
done
for ((ordinal = 0; ordinal < replicas; ordinal++)); do
    pod="$statefulset-$ordinal"
    expected_pod_uid="$(jq -er '.podUid' "$tmpdir/writer-$ordinal.json")"
    expected_images="$(jq -c '.images' "$tmpdir/writer-$ordinal.json")"
    pod_json="$(kubectl "${kubectl_args[@]}" -n "$namespace" get "pod/$pod" -o json)"
    if ! jq -e \
        --arg uid "$expected_pod_uid" \
        --arg ownerUid "$uid" \
        --arg revision "$revision" \
        --argjson images "$expected_images" \
        '.metadata.uid == $uid
         and .metadata.deletionTimestamp == null
         and .metadata.labels["controller-revision-hash"] == $revision
         and any(.metadata.ownerReferences[]?;
             .kind == "StatefulSet" and .uid == $ownerUid and .controller == true)
         and any(.status.conditions[]?; .type == "Ready" and .status == "True")
         and ([.status.containerStatuses | sort_by(.name)[] |
             {name: .name, image: .image, imageId: .imageID}] == $images)
         and all(.status.containerStatuses[]; .ready == true)' \
        <<<"$pod_json" >/dev/null; then
        echo "$pod changed or became unready while writer addresses were collected; collect again" >&2
        exit 1
    fi
done

writer_secrets="$(jq -s 'sort_by(.name)' "$tmpdir"/secret-*.json)"
writers="$(jq -s 'sort_by(.ordinal)' "$tmpdir"/writer-*.json)"
jq -cn \
    --arg collectedAt "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" \
    --arg context "$context" \
    --arg namespace "$namespace" \
    --arg name "$statefulset" \
    --arg uid "$uid" \
    --argjson generation "$generation" \
    --arg revision "$revision" \
    --argjson replicas "$replicas" \
    --argjson currentReplicas "$current_replicas" \
    --argjson updatedReplicas "$updated_replicas" \
    --argjson readyReplicas "$ready_replicas" \
    --argjson writerSecrets "$writer_secrets" \
    --argjson writerSecretProviders "$writer_secret_bindings" \
    --argjson writers "$writers" \
    '{
        schemaVersion: 1,
        collectedAt: $collectedAt,
        context: $context,
        namespace: $namespace,
        statefulSet: {
            name: $name,
            uid: $uid,
            generation: $generation,
            revision: $revision,
            replicas: $replicas,
            currentReplicas: $currentReplicas,
            updatedReplicas: $updatedReplicas,
            readyReplicas: $readyReplicas
        },
        writerSecrets: $writerSecrets,
        writerSecretProviders: $writerSecretProviders,
        writers: $writers
    }'
