"""File storage for research PDFs and figure images: Google Drive or local disk.

``STORAGE_MODE=local`` keeps files under ``LOCAL_STORAGE_DIR`` instead of Drive.
Local file ids start with ``local-``, so reads and deletes go to the right
backend whatever the current mode is.
"""
from __future__ import annotations

import io
import json
import re
import uuid
from pathlib import Path

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseUpload, MediaIoBaseDownload

from config import settings

_SCOPES = ["https://www.googleapis.com/auth/drive.file"]
_CREDS_FILE = Path(__file__).parent.parent / "credentials.json"
_TOKEN_FILE = Path(__file__).parent.parent / "token.json"


def _resolve_path(configured_path: str, default_path: Path) -> Path:
    if configured_path:
        return Path(configured_path).expanduser()
    return default_path


def _get_creds_file() -> Path:
    return _resolve_path(settings.google_credentials_file, _CREDS_FILE)


def _get_token_file() -> Path:
    return _resolve_path(settings.google_token_file, _TOKEN_FILE)


def _build_client_config() -> dict:
    creds_file = _get_creds_file()
    if creds_file.exists():
        return {"creds_file": creds_file}

    if settings.google_client_id and settings.google_client_secret:
        return {
            "client_config": {
                "installed": {
                    "client_id": settings.google_client_id,
                    "client_secret": settings.google_client_secret,
                    "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                    "token_uri": "https://oauth2.googleapis.com/token",
                    "redirect_uris": ["http://localhost"],
                }
            }
        }

    raise FileNotFoundError(
        "Google Drive OAuth client credentials not configured. "
        "Set GOOGLE_CREDENTIALS_FILE, add backend/credentials.json, or set "
        "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env."
    )


_LOCAL_PREFIX = "local-"
_LOCAL_ID = re.compile(r"^local-[0-9a-f]{32}\.(pdf|png)$")


def _use_local() -> bool:
    return (settings.storage_mode or "drive").strip().lower() == "local"


def _is_local(file_id: str) -> bool:
    return file_id.startswith(_LOCAL_PREFIX)


def _local_path(file_id: str) -> Path:
    if not _LOCAL_ID.match(file_id):
        raise ValueError(f"Invalid local file id: {file_id!r}")
    return Path(settings.local_storage_dir).expanduser() / file_id


def _save_local(data: bytes, ext: str) -> str:
    file_id = f"{_LOCAL_PREFIX}{uuid.uuid4().hex}.{ext}"
    path = _local_path(file_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return file_id


def get_drive_service():
    """Return an authenticated Drive v3 service object."""
    creds = None
    token_file = _get_token_file()
    if token_file.exists():
        creds = Credentials.from_authorized_user_file(str(token_file), _SCOPES)
    elif settings.google_token_json.strip():
        # Hosts without a persistent disk (Heroku) pass token.json's contents as an env var.
        creds = Credentials.from_authorized_user_info(json.loads(settings.google_token_json), _SCOPES)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            client_source = _build_client_config()
            if "creds_file" in client_source:
                flow = InstalledAppFlow.from_client_secrets_file(
                    str(client_source["creds_file"]), _SCOPES
                )
            else:
                flow = InstalledAppFlow.from_client_config(
                    client_source["client_config"], _SCOPES
                )
            creds = flow.run_local_server(port=0)
        token_file.parent.mkdir(parents=True, exist_ok=True)
        token_file.write_text(creds.to_json())

    return build("drive", "v3", credentials=creds)


def upload_pdf(pdf_bytes: bytes, filename: str) -> str:
    """Upload *pdf_bytes* to the configured Drive folder and return the file ID."""
    if _use_local():
        return _save_local(pdf_bytes, "pdf")
    service = get_drive_service()
    file_metadata = {
        "name": filename,
        "parents": [settings.google_drive_folder_id],
    }
    media = MediaIoBaseUpload(io.BytesIO(pdf_bytes), mimetype="application/pdf", resumable=False)
    result = (
        service.files()
        .create(body=file_metadata, media_body=media, fields="id")
        .execute()
    )
    return result["id"]


def get_file_url(file_id: str) -> str:
    """Return a browser-viewable URL for the given Drive file ID."""
    if _is_local(file_id):
        return ""
    return f"https://drive.google.com/file/d/{file_id}/view"


def download_pdf(file_id: str) -> bytes:
    """Download a Drive file and return its raw bytes."""
    if _is_local(file_id):
        return _local_path(file_id).read_bytes()
    service = get_drive_service()
    buf = io.BytesIO()
    request = service.files().get_media(fileId=file_id)
    downloader = MediaIoBaseDownload(buf, request)
    done = False
    while not done:
        _, done = downloader.next_chunk()
    return buf.getvalue()


_figures_folder_id: str | None = None


def _get_figures_folder() -> str:
    """Return (creating if needed) the Drive subfolder id for figures."""
    global _figures_folder_id
    if _figures_folder_id:
        return _figures_folder_id
    service = get_drive_service()
    # Search for an existing "figures" folder inside the main folder
    q = (
        f"name = 'figures' "
        f"and mimeType = 'application/vnd.google-apps.folder' "
        f"and '{settings.google_drive_folder_id}' in parents "
        f"and trashed = false"
    )
    res = service.files().list(q=q, fields="files(id)", pageSize=1).execute()
    files = res.get("files", [])
    if files:
        _figures_folder_id = files[0]["id"]
    else:
        folder = service.files().create(
            body={
                "name": "figures",
                "mimeType": "application/vnd.google-apps.folder",
                "parents": [settings.google_drive_folder_id],
            },
            fields="id",
        ).execute()
        _figures_folder_id = folder["id"]
    return _figures_folder_id


def upload_image(image_bytes: bytes, filename: str) -> str:
    """Upload PNG image bytes to the figures subfolder and return the file ID."""
    if _use_local():
        return _save_local(image_bytes, "png")
    service = get_drive_service()
    folder_id = _get_figures_folder()
    file_metadata = {"name": filename, "parents": [folder_id]}
    media = MediaIoBaseUpload(io.BytesIO(image_bytes), mimetype="image/png", resumable=False)
    result = (
        service.files()
        .create(body=file_metadata, media_body=media, fields="id")
        .execute()
    )
    return result["id"]


def delete_file(file_id: str) -> None:
    """Move a Drive file to trash (soft delete); local files are removed."""
    if _is_local(file_id):
        _local_path(file_id).unlink(missing_ok=True)
        return
    service = get_drive_service()
    service.files().update(fileId=file_id, body={"trashed": True}).execute()
