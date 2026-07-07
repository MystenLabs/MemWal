#!/usr/bin/env python3
import os
import sys
import time
import subprocess
import threading
from mock_server import run_server

def main():
    print("=" * 60)
    print("  WALRUS MEMORY E2E TEST RUNNER")
    print("=" * 60)

    # 1. Start Mock Server in a background thread
    mock_port = 8080
    mock_thread = threading.Thread(target=run_server, args=(mock_port,), daemon=True)
    mock_thread.start()
    print(f"[*] Started Mock Server on port {mock_port}")
    time.sleep(1)

    # 2. Boot docker-compose Postgres and Redis
    print("[*] Starting Docker containers (Postgres and Redis)...")
    try:
        subprocess.run(
            ["docker", "compose", "-f", "services/server/docker-compose.yml", "up", "-d"],
            check=True
        )
        print("[+] Docker containers are up")
    except Exception as e:
        print(f"[!] Warning: Docker compose failed to start: {e}")
        print("    Assuming they might already be running or running in a different environment.")

    # 3. Compile and launch the Axum Relayer Server
    print("[*] Starting Axum Relayer Server...")
    relayer_port = 3001
    
    # Generate mock 32-byte Ed25519 key (64 hex characters)
    mock_private_key = "00" * 32
    
    env = os.environ.copy()
    env["PORT"] = str(relayer_port)
    env["DATABASE_URL"] = "postgresql://memwal:memwal_secret@localhost:5432/memwal"
    env["REDIS_URL"] = "redis://localhost:6379"
    env["SUI_RPC_URL"] = f"http://localhost:{mock_port}/sui"
    env["SUI_NETWORK"] = "mainnet"
    env["OPENAI_API_BASE"] = f"http://localhost:{mock_port}/v1"
    env["OPENAI_API_KEY"] = "mock-openai-key"
    env["WALRUS_PUBLISHER_URL"] = f"http://localhost:{mock_port}"
    env["WALRUS_AGGREGATOR_URL"] = f"http://localhost:{mock_port}"
    env["SIDECAR_URL"] = f"http://localhost:{mock_port}"
    env["SIDECAR_SECRET"] = "mock-sidecar-secret"
    env["SERVER_SUI_PRIVATE_KEY"] = mock_private_key
    env["PACKAGE_ID"] = "0xpackage123"
    env["REGISTRY_ID"] = "0xregistry123"
    
    # We specify RUSTC pointing directly to stable binary to help rustup bypass wrapper checks if run unsandboxed
    env["RUSTC"] = "/Users/harryphan/.rustup/toolchains/stable-aarch64-apple-darwin/bin/rustc"

    # Start Axum relayer
    relayer_cmd = [
        "/Users/harryphan/.rustup/toolchains/stable-aarch64-apple-darwin/bin/cargo",
        "run",
        "--manifest-path", "services/server/Cargo.toml"
    ]
    
    try:
        relayer_process = subprocess.Popen(
            relayer_cmd,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True
        )
    except FileNotFoundError:
        # Fall back to cargo in path if direct toolchain cargo is not there
        relayer_cmd[0] = "cargo"
        relayer_process = subprocess.Popen(
            relayer_cmd,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True
        )

    # Monitor output for server startup
    print("[*] Waiting for Relayer Server to boot on port 3001...")
    server_ready = False
    start_time = time.time()
    
    # Thread to print relayer logs in background
    def print_relayer_logs(proc):
        nonlocal server_ready
        for line in proc.stdout:
            print(f"  [Relayer] {line.strip()}")
            if "starting memwal server" in line.lower() or "listening on" in line.lower() or "port 3001" in line:
                server_ready = True

    log_thread = threading.Thread(target=print_relayer_logs, args=(relayer_process,), daemon=True)
    log_thread.start()

    # Wait up to 30 seconds for server startup
    while time.time() - start_time < 30:
        # Probe port 3001
        import socket
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(0.5)
        if s.connect_ex(('127.0.0.1', relayer_port)) == 0:
            server_ready = True
            s.close()
            break
        s.close()
        time.sleep(0.5)

    if not server_ready:
        print("[!] Error: Relayer Server failed to start on port 3001.")
        # Terminate processes
        relayer_process.terminate()
        sys.exit(1)
        
    print("[+] Relayer Server is running and listening on port 3001!")

    # 4. Run Pytest
    print("[*] Running pytest suite...")
    pytest_env = os.environ.copy()
    pytest_env["TEST_BASE_URL"] = f"http://localhost:{relayer_port}"
    pytest_env["MOCK_SERVER_URL"] = f"http://localhost:{mock_port}"
    # Add our local pip packages to python path
    pytest_env["PYTHONPATH"] = "/Users/harryphan/Documents/dev/MemWal/.pip_packages"
    
    pytest_cmd = [
        "python3", "-m", "pytest", "services/server/tests/test_e2e.py", "-v"
    ]
    
    try:
        pytest_res = subprocess.run(pytest_cmd, env=pytest_env)
        exit_code = pytest_res.returncode
    except Exception as e:
        print(f"[!] Error running pytest: {e}")
        exit_code = 1

    # 5. Clean up Relayer process
    print("[*] Cleaning up processes...")
    relayer_process.terminate()
    try:
        relayer_process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        relayer_process.kill()

    print(f"[+] Relayer Server terminated")
    print("=" * 60)
    if exit_code == 0:
        print("  [SUCCESS] All E2E test cases passed!")
    else:
        print("  [FAILURE] Some test cases failed.")
    print("=" * 60)
    sys.exit(exit_code)

if __name__ == '__main__':
    main()
