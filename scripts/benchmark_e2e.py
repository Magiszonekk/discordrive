#!/usr/bin/env python3
"""
DiscorDrive v4 — Simple E2E Speed Test (single-blob baseline)

Baseline do porównań: 1x initUpload → 1x PUT całego pliku → 1x commitManifest(blobs)
Bez browserowego chunkingu, bez frontendowego per-chunk crypto/concurrency.
"""

import hashlib
import os
import sys
import time
import json as json_mod
import requests

BASE_URL = os.getenv("DDC_TEST_URL", "http://localhost:3000")
TEST_LOGIN = os.getenv("DDC_TEST_LOGIN", "Magiszonek")
TEST_PASSWORD = os.getenv("DDC_TEST_PASSWORD", "speedtest123")
TEST_FILE_SIZE_MB = int(sys.argv[1]) if len(sys.argv) > 1 else 360
GRAPHQL = f"{BASE_URL}/graphql"


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def human_bytes(n: int) -> str:
    if n >= 1_073_741_824:
        return f"{n / 1_073_741_824:.2f} GB"
    if n >= 1_048_576:
        return f"{n / 1_048_576:.2f} MB"
    if n >= 1024:
        return f"{n / 1024:.1f} KB"
    return f"{n} B"


def fmt_duration(ms: float) -> str:
    if ms >= 60_000:
        return f"{ms / 60_000:.1f} min"
    if ms >= 1_000:
        return f"{ms / 1_000:.2f} s"
    return f"{ms:.0f} ms"


def mbps(byte_count: int, elapsed_ms: float) -> float:
    return (byte_count / (1024 * 1024)) / (elapsed_ms / 1000)


def gql(query: str, variables: dict = None, token: str = None, timeout: int = 120):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    payload = {"query": query}
    if variables:
        payload["variables"] = variables
    resp = requests.post(GRAPHQL, json=payload, headers=headers, timeout=timeout)
    data = resp.json()
    if "errors" in data:
        raise RuntimeError(f"GraphQL error: {data['errors']}")
    return data["data"]


def login() -> tuple[str, str]:
    login_data = gql(
        'mutation($emailOrUsername: String!, $password: String!) { login(emailOrUsername: $emailOrUsername, password: $password) { token user { id } } }',
        {"emailOrUsername": TEST_LOGIN, "password": TEST_PASSWORD},
    )
    return login_data["login"]["token"], login_data["login"]["user"]["id"]


def main():
    file_size = TEST_FILE_SIZE_MB * (1 << 20)

    print()
    print("╔═══════════════════════════════════════════════════════════════════╗")
    print("║     DiscorDrive v4 — Simple E2E Baseline (single-blob path)     ║")
    print("╠═══════════════════════════════════════════════════════════════════╣")
    print(f"║  Server:     {BASE_URL:<49}║")
    print(f"║  File size:  {human_bytes(file_size):<49}║")
    print(f"║  Target:     {TEST_LOGIN:<49}║")
    print("╚══════════════════════════════════════════════════════════════════╝")
    print()

    print("🔐 Login...")
    token, user_id = login()
    print(f"   user_id={user_id[:12]}...")
    print()

    print(f"📦 Generating test file ({TEST_FILE_SIZE_MB} MB)...")
    gen_start = time.perf_counter()
    data = os.urandom(file_size)
    gen_ms = (time.perf_counter() - gen_start) * 1000
    expected_hash = sha256(data)
    print(f"   generated {human_bytes(len(data))} in {fmt_duration(gen_ms)}")
    print(f"   sha256: {expected_hash[:24]}...")
    print()

    print("📤 initUpload...")
    init_start = time.perf_counter()
    init_data = gql(
        '''mutation($parentFolderId: ID, $name: String, $mimeType: String, $wrappedFEK: String!, $totalCiphertextBytes: String!, $chunkCount: Int!) {
            initUpload(parentFolderId: $parentFolderId, name: $name, mimeType: $mimeType, wrappedFEK: $wrappedFEK, totalCiphertextBytes: $totalCiphertextBytes, chunkCount: $chunkCount) { fileId status }
        }''',
        {
            "parentFolderId": None,
            "name": f"simple-benchmark-{int(time.time())}.bin",
            "mimeType": "application/octet-stream",
            "wrappedFEK": "dGVzdGtleWJhc2U2NA==",
            "totalCiphertextBytes": str(file_size),
            "chunkCount": 1,
        },
        token,
    )
    file_id = init_data["initUpload"]["fileId"]
    init_ms = (time.perf_counter() - init_start) * 1000
    print(f"   fileId: {file_id[:16]}... ({fmt_duration(init_ms)})")
    print()

    print(f"⬆️  Upload 1x blob ({human_bytes(file_size)})...")
    upload_url = f"{BASE_URL}/api/blob/{file_id}"
    upload_start = time.perf_counter()
    resp = requests.put(
        upload_url,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/octet-stream",
        },
        data=data,
        timeout=600,
    )
    upload_ms = (time.perf_counter() - upload_start) * 1000
    if resp.status_code != 200:
        print(f"   ❌ Upload failed: HTTP {resp.status_code}")
        print(f"      {resp.text[:500]}")
        return 1
    upload_result = resp.json()
    upload_speed = mbps(len(data), upload_ms)
    print(f"   upload: {fmt_duration(upload_ms)} @ {upload_speed:.2f} MB/s")
    print()

    print("📋 commitManifest(blobs)...")
    commit_start = time.perf_counter()
    gql(
        '''mutation($fileId: ID!, $manifestBlobId: String!, $totalCiphertextBytes: String!, $chunkCount: Int!, $blobs: [UploadedBlobTransportInput!]!) {
            commitManifest(fileId: $fileId, manifestBlobId: $manifestBlobId, totalCiphertextBytes: $totalCiphertextBytes, chunkCount: $chunkCount, blobs: $blobs) { success }
        }''',
        {
            "fileId": file_id,
            "manifestBlobId": file_id,
            "totalCiphertextBytes": str(file_size),
            "chunkCount": 1,
            "blobs": [{
                "blobId": upload_result["blobId"],
                "storageKind": upload_result["storageKind"],
                "storagePath": upload_result["storagePath"],
                "ciphertextSizeBytes": upload_result["ciphertextSizeBytes"],
                "ciphertextHash": upload_result.get("ciphertextHash"),
                "discordMessageId": upload_result.get("discordMessageId"),
                "discordChannelId": upload_result.get("discordChannelId"),
                "webhookId": upload_result.get("webhookId"),
            }],
        },
        token,
    )
    commit_ms = (time.perf_counter() - commit_start) * 1000
    print(f"   commit: {fmt_duration(commit_ms)}")
    print()

    print(f"⬇️  Download 1x blob ({human_bytes(file_size)})...")
    download_url = f"{BASE_URL}/api/blob/{file_id}"
    download_start = time.perf_counter()
    dl_resp = requests.get(download_url, headers={"Authorization": f"Bearer {token}"}, timeout=600)
    download_ms = (time.perf_counter() - download_start) * 1000
    if dl_resp.status_code != 200:
        print(f"   ❌ Download failed: HTTP {dl_resp.status_code}")
        return 1
    downloaded = dl_resp.content
    download_speed = mbps(len(downloaded), download_ms)
    dl_hash = sha256(downloaded)
    hash_ok = dl_hash == expected_hash
    print(f"   download: {fmt_duration(download_ms)} @ {download_speed:.2f} MB/s")
    print(f"   hash: {'PASS' if hash_ok else 'FAIL'}")
    print()

    print("🗑️  Delete file...")
    delete_start = time.perf_counter()
    gql('mutation($fileId: ID!) { deleteFile(fileId: $fileId) }', {"fileId": file_id}, token)
    delete_ms = (time.perf_counter() - delete_start) * 1000
    print(f"   delete: {fmt_duration(delete_ms)}")
    print()

    upload_path_ms = init_ms + upload_ms + commit_ms
    results = {
        "mode": "simple-single-blob",
        "file_size_bytes": len(data),
        "upload_path_ms": round(upload_path_ms, 1),
        "upload_path_speed_mbps": round(mbps(len(data), upload_path_ms), 2),
        "init_ms": round(init_ms, 1),
        "upload_ms": round(upload_ms, 1),
        "upload_speed_mbps": round(upload_speed, 2),
        "commit_ms": round(commit_ms, 1),
        "download_ms": round(download_ms, 1),
        "download_speed_mbps": round(download_speed, 2),
        "delete_ms": round(delete_ms, 1),
        "hash_verified": hash_ok,
    }
    results_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "benchmark_results_simple.json")
    with open(results_path, "w") as f:
        json_mod.dump(results, f, indent=2)

    print("╔═══════════════════════════════════════════════════════════════════╗")
    print("║                    📊 SIMPLE BASELINE SUMMARY                    ║")
    print("╠═══════════════════════════════════════════════════════════════════╣")
    print(f"║  Upload path total: {fmt_duration(upload_path_ms):>10} @ {mbps(len(data), upload_path_ms):>7.2f} MB/s{'':<14}║")
    print(f"║  Upload only:       {fmt_duration(upload_ms):>10} @ {upload_speed:>7.2f} MB/s{'':<14}║")
    print(f"║  Download only:     {fmt_duration(download_ms):>10} @ {download_speed:>7.2f} MB/s{'':<14}║")
    print(f"║  Hash:              {'PASS' if hash_ok else 'FAIL':<45}║")
    print("╚══════════════════════════════════════════════════════════════════╝")
    print(f"\n💾 Results saved: {results_path}\n")
    return 0 if hash_ok else 1


if __name__ == "__main__":
    sys.exit(main())
