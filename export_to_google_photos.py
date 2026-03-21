#!/usr/bin/env python3
"""
Wedding Photos — Export to Google Photos
-----------------------------------------
Pulls all approved photos from Cloudflare R2 and uploads them to Google Photos,
sorted into albums by location (Trad, Reception, etc.)

REQUIREMENTS
  pip install boto3 requests google-auth google-auth-oauthlib google-api-python-client

SETUP (one time)
  1. Install rclone: https://rclone.org/downloads/
  2. Run: rclone config
       - Add a new remote called "gphotos" of type "Google Photos"
       - Follow the browser login for the couple's Google account
  3. Fill in your R2 credentials below (Cloudflare → R2 → Manage R2 API Tokens)
  4. Run: python3 export_to_google_photos.py
"""

import os
import sys
import subprocess
import tempfile
import json
import boto3
from botocore.config import Config

# ── FILL THESE IN ─────────────────────────────────────────────────────────────
R2_ACCESS_KEY_ID     = "YOUR_R2_ACCESS_KEY_ID"      # R2 → Manage R2 API Tokens
R2_SECRET_ACCESS_KEY = "YOUR_R2_SECRET_ACCESS_KEY"
R2_ACCOUNT_ID        = "eb8193d2791bec64568e1115104e2e1d"
BUCKET_NAME          = "wedding-uploads"
RCLONE_REMOTE        = "gphotos"                     # name you gave in rclone config
ALBUM_PREFIX         = "Ifewande & Tunde Wedding"    # album names will be e.g. "Ifewande & Tunde Wedding — Trad"
# ──────────────────────────────────────────────────────────────────────────────

ENDPOINT = f"https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com"

def check_rclone():
    try:
        subprocess.run(["rclone", "version"], capture_output=True, check=True)
    except (FileNotFoundError, subprocess.CalledProcessError):
        print("❌  rclone not found. Install from https://rclone.org/downloads/ then run again.")
        sys.exit(1)

def get_r2_client():
    return boto3.client(
        "s3",
        endpoint_url=ENDPOINT,
        aws_access_key_id=R2_ACCESS_KEY_ID,
        aws_secret_access_key=R2_SECRET_ACCESS_KEY,
        config=Config(signature_version="s3v4"),
        region_name="auto",
    )

def list_approved_photos(s3):
    photos = []
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=BUCKET_NAME, Prefix="approved/"):
        for obj in page.get("Contents", []):
            # Get object metadata to retrieve location
            head = s3.head_object(Bucket=BUCKET_NAME, Key=obj["Key"])
            meta = head.get("Metadata", {})
            photos.append({
                "key":      obj["Key"],
                "size":     obj["Size"],
                "location": meta.get("location", "Uncategorised").strip() or "Uncategorised",
                "name":     meta.get("name", ""),
                "ext":      obj["Key"].split(".")[-1].lower(),
            })
    return photos

def upload_to_google_photos(local_path, album_name):
    result = subprocess.run(
        ["rclone", "copy", local_path, f"{RCLONE_REMOTE}:album/{album_name}", "--progress"],
        capture_output=False,
    )
    return result.returncode == 0

def main():
    print("🌸  Wedding Photo Export — Ifewande")
    print("─" * 45)

    check_rclone()

    if "YOUR_R2" in R2_ACCESS_KEY_ID:
        print("❌  Please fill in your R2 credentials at the top of this script.")
        sys.exit(1)

    s3 = get_r2_client()

    print("📋  Listing approved photos from R2…")
    photos = list_approved_photos(s3)
    if not photos:
        print("No approved photos found.")
        sys.exit(0)
    print(f"    Found {len(photos)} photos\n")

    # Group by location
    by_location = {}
    for p in photos:
        loc = p["location"]
        by_location.setdefault(loc, []).append(p)

    print("📂  Albums to create:")
    for loc, items in by_location.items():
        print(f"    {ALBUM_PREFIX} — {loc}  ({len(items)} photos)")
    print()

    with tempfile.TemporaryDirectory() as tmp:
        total_uploaded = 0
        total_failed   = 0

        for location, items in by_location.items():
            album_name  = f"{ALBUM_PREFIX} — {location}"
            album_dir   = os.path.join(tmp, location)
            os.makedirs(album_dir, exist_ok=True)

            print(f"⬇️   Downloading {len(items)} photos for '{location}'…")
            for i, photo in enumerate(items, 1):
                fname = f"{i:04d}_{photo['name'].replace(' ','_') or 'guest'}.{photo['ext']}"
                dest  = os.path.join(album_dir, fname)
                try:
                    s3.download_file(BUCKET_NAME, photo["key"], dest)
                except Exception as e:
                    print(f"    ⚠️  Failed to download {photo['key']}: {e}")
                    total_failed += 1
                    continue

            print(f"☁️   Uploading to Google Photos album '{album_name}'…")
            ok = upload_to_google_photos(album_dir, album_name)
            if ok:
                total_uploaded += len(items)
                print(f"    ✓  Done\n")
            else:
                print(f"    ⚠️  Some uploads may have failed\n")

    print("─" * 45)
    print(f"✅  Export complete — {total_uploaded} photos uploaded")
    if total_failed:
        print(f"⚠️   {total_failed} photos failed to download from R2")

if __name__ == "__main__":
    main()
