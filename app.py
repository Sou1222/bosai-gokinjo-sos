"""
防災ご近所SOS - バックエンド (Flask + SQLite)

災害直後、行政の支援が届く前の「ご近所同士の助け合い」を
距離・スキル・緊急度でスコアリングしてマッチングするデモアプリ。
"""

import math
import os
import sqlite3
import time
import uuid
from pathlib import Path

from flask import Flask, g, jsonify, render_template, request, send_from_directory

# Render では永続ディスクを DATA_DIR (例: /var/data) にマウントして使う。
# 未設定ならローカル同様プロジェクト直下に保存する。
DATA_DIR = Path(os.environ.get("DATA_DIR", Path(__file__).parent))
DATA_DIR.mkdir(parents=True, exist_ok=True)

DB_PATH = DATA_DIR / "sos.db"
UPLOAD_DIR = DATA_DIR / "uploads"
ALLOWED_IMAGE_EXTENSIONS = {"png", "jpg", "jpeg", "gif", "webp"}

SKILL_CATEGORIES = [
    "水・食料",
    "医療・介助",
    "高齢者見守り",
    "力仕事・瓦礫撤去",
    "情報伝達・通訳",
    "ペット対応",
    "子ども対応",
    "その他",
]

URGENCY_LABELS = {3: "緊急", 2: "高", 1: "中"}

# マッチングスコアの重み(企画書のロジックと対応)
WEIGHT_DISTANCE = 0.5
WEIGHT_SKILL = 0.3
WEIGHT_URGENCY = 0.2
SEARCH_RADIUS_KM = 2.0  # この範囲内の協力者のみ候補にする

app = Flask(__name__)


def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
    return g.db


@app.teardown_appcontext
def close_db(exception=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    db = sqlite3.connect(DB_PATH)
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            lat REAL NOT NULL,
            lng REAL NOT NULL,
            category TEXT NOT NULL,
            description TEXT NOT NULL,
            urgency INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'open',
            created_at REAL NOT NULL
        );

        CREATE TABLE IF NOT EXISTS helpers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            lat REAL NOT NULL,
            lng REAL NOT NULL,
            skills TEXT NOT NULL,
            available INTEGER NOT NULL DEFAULT 1,
            created_at REAL NOT NULL
        );

        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            request_id INTEGER NOT NULL,
            helper_id INTEGER NOT NULL,
            sender TEXT NOT NULL,
            body TEXT NOT NULL,
            created_at REAL NOT NULL
        );
        """
    )
    # 既存DBに画像カラムを追加(なければ)
    for table in ("requests", "helpers"):
        try:
            db.execute(f"ALTER TABLE {table} ADD COLUMN image TEXT")
        except sqlite3.OperationalError:
            pass
    db.commit()
    db.close()
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


def save_uploaded_image(file_storage):
    """アップロード画像を保存し、ファイル名を返す(なければNone)"""
    if not file_storage or not file_storage.filename:
        return None
    ext = file_storage.filename.rsplit(".", 1)[-1].lower() if "." in file_storage.filename else ""
    if ext not in ALLOWED_IMAGE_EXTENSIONS:
        return None
    filename = f"{uuid.uuid4().hex}.{ext}"
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    file_storage.save(UPLOAD_DIR / filename)
    return filename


def haversine_km(lat1, lng1, lat2, lng2):
    """2地点間の距離を km で返す"""
    r = 6371.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lng2 - lng1)
    a = (
        math.sin(dphi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    )
    return 2 * r * math.asin(math.sqrt(a))


def score_match(req_row, helper_row):
    """距離・スキル一致・緊急度からマッチ度スコア(0〜1)を計算"""
    dist = haversine_km(req_row["lat"], req_row["lng"], helper_row["lat"], helper_row["lng"])
    if dist > SEARCH_RADIUS_KM:
        return None, dist

    distance_score = max(0.0, 1 - dist / SEARCH_RADIUS_KM)
    helper_skills = set(s.strip() for s in helper_row["skills"].split(","))
    skill_score = 1.0 if req_row["category"] in helper_skills else 0.2
    urgency_score = req_row["urgency"] / 3.0

    total = (
        WEIGHT_DISTANCE * distance_score
        + WEIGHT_SKILL * skill_score
        + WEIGHT_URGENCY * urgency_score
    )
    return round(total, 3), round(dist, 3)


def find_matches(req_row, db, limit=5):
    helpers = db.execute(
        "SELECT * FROM helpers WHERE available = 1"
    ).fetchall()
    scored = []
    for h in helpers:
        s, dist = score_match(req_row, h)
        if s is None:
            continue
        scored.append(
            {
                "helper_id": h["id"],
                "name": h["name"],
                "skills": h["skills"],
                "lat": h["lat"],
                "lng": h["lng"],
                "distance_km": dist,
                "score": s,
            }
        )
    scored.sort(key=lambda x: x["score"], reverse=True)
    return scored[:limit]


# gunicorn など WSGI サーバー経由で起動された場合でも
# 必ずテーブル作成・カラム追加・uploads ディレクトリ生成を行う
init_db()


@app.route("/uploads/<path:filename>")
def uploaded_file(filename):
    return send_from_directory(UPLOAD_DIR, filename)


@app.route("/")
def index():
    return render_template(
        "index.html",
        skill_categories=SKILL_CATEGORIES,
        urgency_labels=URGENCY_LABELS,
    )


@app.route("/api/requests", methods=["GET", "POST"])
def api_requests():
    db = get_db()
    if request.method == "POST":
        data = request.form
        for field in ("name", "lat", "lng", "category", "description", "urgency"):
            if not data.get(field):
                return jsonify({"error": f"{field} は必須です"}), 400
        image = save_uploaded_image(request.files.get("image"))
        db.execute(
            """INSERT INTO requests (name, lat, lng, category, description, urgency, status, image, created_at)
               VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)""",
            (
                data["name"],
                float(data["lat"]),
                float(data["lng"]),
                data["category"],
                data["description"],
                int(data["urgency"]),
                image,
                time.time(),
            ),
        )
        db.commit()
        return jsonify({"ok": True}), 201

    # 解決済みは一覧から消す
    rows = db.execute(
        "SELECT * FROM requests WHERE status = 'open' ORDER BY urgency DESC, created_at DESC"
    ).fetchall()
    results = []
    for r in rows:
        results.append(
            {
                "id": r["id"],
                "name": r["name"],
                "lat": r["lat"],
                "lng": r["lng"],
                "category": r["category"],
                "description": r["description"],
                "urgency": r["urgency"],
                "urgency_label": URGENCY_LABELS.get(r["urgency"], "中"),
                "status": r["status"],
                "image_url": f"/uploads/{r['image']}" if r["image"] else None,
                "matches": find_matches(r, db),
            }
        )

    sort = request.args.get("sort", "urgency")
    if sort == "distance":
        lat = request.args.get("lat", type=float)
        lng = request.args.get("lng", type=float)
        if lat is not None and lng is not None:
            for item in results:
                item["distance_from_me"] = round(
                    haversine_km(lat, lng, item["lat"], item["lng"]), 3
                )
            results.sort(key=lambda x: x["distance_from_me"])
    elif sort == "category":
        results.sort(key=lambda x: x["category"])

    return jsonify(results)


@app.route("/api/requests/<int:req_id>/resolve", methods=["POST"])
def resolve_request(req_id):
    db = get_db()
    db.execute("UPDATE requests SET status = 'resolved' WHERE id = ?", (req_id,))
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/helpers", methods=["GET", "POST"])
def api_helpers():
    db = get_db()
    if request.method == "POST":
        data = request.form
        for field in ("name", "lat", "lng"):
            if not data.get(field):
                return jsonify({"error": f"{field} は必須です"}), 400
        skills = request.form.getlist("skills")
        if not skills:
            return jsonify({"error": "skills は必須です"}), 400
        image = save_uploaded_image(request.files.get("image"))
        db.execute(
            """INSERT INTO helpers (name, lat, lng, skills, available, image, created_at)
               VALUES (?, ?, ?, ?, 1, ?, ?)""",
            (
                data["name"],
                float(data["lat"]),
                float(data["lng"]),
                ",".join(skills),
                image,
                time.time(),
            ),
        )
        db.commit()
        return jsonify({"ok": True}), 201

    rows = db.execute(
        "SELECT * FROM helpers WHERE available = 1 ORDER BY created_at DESC"
    ).fetchall()
    open_requests = db.execute("SELECT * FROM requests WHERE status = 'open'").fetchall()
    results = []
    for r in rows:
        item = dict(r)
        item["image_url"] = f"/uploads/{r['image']}" if r["image"] else None

        matched = []
        for req in open_requests:
            s, dist = score_match(req, r)
            if s is None:
                continue
            matched.append(
                {
                    "request_id": req["id"],
                    "name": req["name"],
                    "category": req["category"],
                    "urgency_label": URGENCY_LABELS.get(req["urgency"], "中"),
                    "description": req["description"],
                    "distance_km": dist,
                    "score": s,
                }
            )
        matched.sort(key=lambda x: x["score"], reverse=True)
        item["matched_requests"] = matched[:5]

        results.append(item)
    return jsonify(results)


@app.route("/api/messages", methods=["GET", "POST"])
def api_messages():
    db = get_db()
    if request.method == "POST":
        data = request.get_json(force=True)
        for field in ("request_id", "helper_id", "sender", "body"):
            if not data.get(field):
                return jsonify({"error": f"{field} は必須です"}), 400
        if data["sender"] not in ("requester", "helper"):
            return jsonify({"error": "sender が不正です"}), 400
        db.execute(
            """INSERT INTO messages (request_id, helper_id, sender, body, created_at)
               VALUES (?, ?, ?, ?, ?)""",
            (
                int(data["request_id"]),
                int(data["helper_id"]),
                data["sender"],
                data["body"],
                time.time(),
            ),
        )
        db.commit()
        return jsonify({"ok": True}), 201

    req_id = request.args.get("request_id", type=int)
    helper_id = request.args.get("helper_id", type=int)
    if not req_id or not helper_id:
        return jsonify({"error": "request_id と helper_id が必要です"}), 400
    rows = db.execute(
        "SELECT * FROM messages WHERE request_id = ? AND helper_id = ? ORDER BY created_at ASC",
        (req_id, helper_id),
    ).fetchall()
    return jsonify([dict(r) for r in rows])


if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=5001)
