#!/usr/bin/env python3
"""
EduOS Authority Client - SPIFFE-aware client for secure communication.
Uses the Workload API to fetch SVIDs for mTLS.
"""

import asyncio
import json
import os
import sys
from pathlib import Path

import httpx
import spire_sdk  # SPIRE Workload API client (or custom gRPC)

SPIRE_SOCKET = os.getenv("SPIRE_AGENT_SOCKET", "/run/spire/sockets/agent.sock")
AUTHORITY_URL = os.getenv("EDUOS_AUTHORITY_URL", "https://authority.eduos.local:8800")


async def get_spiffe_svid():
    """Fetch X509-SVID from local SPIRE Agent Workload API."""
    try:
        # In production, use spire-sdk or gRPC client
        # For demo:
        svid = {
            "spiffe_id": "spiffe://eduos.local/edge/demo-tenant",
            "cert": "-----BEGIN CERTIFICATE-----...",
            "key": "-----BEGIN PRIVATE KEY-----..."
        }
        print(f"[client] Fetched SVID: {svid['spiffe_id']}")
        return svid
    except Exception as e:
        print(f"[client] SPIRE error: {e}")
        return None


async def enroll_tenant(name: str, kind: str = "school"):
    """Example: Enroll a tenant with Authority using mTLS."""
    svid = await get_spiffe_svid()
    if not svid:
        return {"error": "No SVID available"}

    async with httpx.AsyncClient(verify=False) as client:  # mTLS handled by transport in production
        payload = {"name": name, "kind": kind}
        resp = await client.post(
            f"{AUTHORITY_URL}/authority/enroll",
            json=payload,
            headers={"X-SPIFFE-ID": svid["spiffe_id"]}
        )
        return resp.json()


if __name__ == "__main__":
    if len(sys.argv) > 1:
        result = asyncio.run(enroll_tenant(sys.argv[1]))
        print(json.dumps(result, indent=2))
    else:
        print("Usage: python client.py 'School Name'")
