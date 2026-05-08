#!/usr/bin/env python3
"""Test the FGAC role mapping logic locally against a live OpenSearch domain.

Usage:
  python3 deployment/test-role-mapping.py <opensearch-endpoint> <region> [--profile PROFILE]

Example:
  python3 deployment/test-role-mapping.py https://search-agent-health-traces-xxx.us-east-1.es.amazonaws.com us-east-1 --profile default
"""
import json
import sys
import urllib.request
import argparse
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from botocore.session import Session

def _signed_request(session, method, url, region, body=None):
    headers = {'Content-Type': 'application/json'}
    request = AWSRequest(method=method, url=url, data=body or '', headers=headers)
    creds = session.get_credentials().get_frozen_credentials()
    SigV4Auth(creds, 'es', region).add_auth(request)
    req = urllib.request.Request(url, data=(body or '').encode('utf-8'), method=method,
                                 headers={k: v for k, v in dict(request.headers).items()})
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, json.loads(resp.read().decode('utf-8', errors='replace'))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode('utf-8', errors='replace'))

def main():
    parser = argparse.ArgumentParser(description='Test FGAC role mapping against OpenSearch')
    parser.add_argument('endpoint', help='OpenSearch domain endpoint (https://...)')
    parser.add_argument('region', help='AWS region')
    parser.add_argument('--profile', default=None, help='AWS profile')
    parser.add_argument('--role-arns', nargs='+', default=['arn:aws:iam::123456789012:role/test-role'],
                        help='Role ARNs to map (replace placeholder account ID)')
    parser.add_argument('--dry-run', action='store_true', help='Only GET current mapping, do not PUT')
    args = parser.parse_args()

    session = Session()
    if args.profile:
        session.set_config_variable('profile', args.profile)

    endpoint = args.endpoint.rstrip('/')

    # Step 1: Check connectivity
    print(f"[1/4] Testing connectivity to {endpoint}...")
    status, resp = _signed_request(session, 'GET', f'{endpoint}/_cluster/health', args.region)
    if status == 200:
        print(f"  OK — cluster: {resp.get('cluster_name')}, status: {resp.get('status')}")
    else:
        print(f"  FAILED ({status}): {json.dumps(resp, indent=2)}")
        sys.exit(1)

    # Step 2: Check current caller identity in OpenSearch
    print(f"\n[2/4] Checking FGAC identity...")
    status, resp = _signed_request(session, 'GET', f'{endpoint}/_plugins/_security/authinfo', args.region)
    if status == 200:
        print(f"  User: {resp.get('user_name')}")
        print(f"  Backend roles: {resp.get('backend_roles', [])}")
        print(f"  Roles: {resp.get('roles', [])}")
        is_admin = 'all_access' in resp.get('roles', [])
        print(f"  Has all_access: {is_admin}")
    else:
        print(f"  FAILED ({status}): {json.dumps(resp, indent=2)}")
        print("  (This likely means the caller is not the master user)")
        sys.exit(1)

    # Step 3: GET current role mapping
    print(f"\n[3/4] Getting current all_access role mapping...")
    status, resp = _signed_request(session, 'GET', f'{endpoint}/_plugins/_security/api/rolesmapping/all_access', args.region)
    if status == 200:
        backend_roles = resp.get('all_access', {}).get('backend_roles', [])
        print(f"  Current backend_roles: {json.dumps(backend_roles, indent=4)}")
    elif status == 404:
        backend_roles = []
        print(f"  No existing mapping (will create)")
    else:
        print(f"  FAILED ({status}): {json.dumps(resp, indent=2)}")
        sys.exit(1)

    # Step 4: PUT updated mapping
    roles_to_add = args.role_arns
    added = []
    for role in roles_to_add:
        if role not in backend_roles:
            backend_roles.append(role)
            added.append(role)

    if not added:
        print(f"\n[4/4] All roles already mapped. Nothing to do.")
        return

    if args.dry_run:
        print(f"\n[4/4] DRY RUN — would add: {json.dumps(added, indent=4)}")
        return

    print(f"\n[4/4] Adding roles: {json.dumps(added, indent=4)}")
    payload = json.dumps({'backend_roles': backend_roles})
    status, resp = _signed_request(session, 'PUT', f'{endpoint}/_plugins/_security/api/rolesmapping/all_access', args.region, payload)
    if status in (200, 201):
        print(f"  SUCCESS: {json.dumps(resp)}")
    else:
        print(f"  FAILED ({status}): {json.dumps(resp, indent=2)}")
        sys.exit(1)

if __name__ == '__main__':
    main()
