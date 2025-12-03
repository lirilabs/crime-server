import fetch from "node-fetch";

let subscribers = new Set();
let watching = false;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  const owner = "lirilabs";
  const repo = "crime";
  const token = process.env.GITHUB_TOKEN;

  const headers = {
    Authorization: `token ${token}`,
    "User-Agent": "live-github-fs"
  };

  // ============================================================
  // RECURSIVE FOLDER READER WITH SHA MAP
  // ============================================================
  async function readFolder(path = "") {
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
    const resp = await fetch(url, { headers });
    const arr = await resp.json();

    if (!Array.isArray(arr)) return [];

    const list = [];
    for (const item of arr) {
      if (item.type === "dir") {
        list.push({
          name: item.name,
          type: "directory",
          sha: item.sha,
          path: item.path,
          children: await readFolder(item.path)
        });
      } else {
        const fileResp = await fetch(item.download_url);
        const content = await fileResp.text();
        list.push({
          name: item.name,
          type: "file",
          sha: item.sha,
          path: item.path,
          content
        });
      }
    }
    return list;
  }

  // Build SHA map from structure
  function buildShaMap(structure) {
    const shaMap = {};
    function traverse(items) {
      items.forEach(item => {
        shaMap[item.path] = item.sha;
        if (item.type === "directory" && item.children) {
          traverse(item.children);
        }
      });
    }
    traverse(structure);
    return shaMap;
  }

  // Get full snapshot
  async function getSnapshot() {
    const structure = await readFolder("");
    const shaMap = buildShaMap(structure);
    return { structure, shaMap };
  }

  // ============================================================
  // LIVE UPDATE BROADCASTER
  // ============================================================
  function broadcast(data) {
    const json = JSON.stringify(data);
    for (const client of subscribers) {
      try {
        client.write(`data: ${json}\n\n`);
      } catch (e) {
        subscribers.delete(client);
      }
    }
  }

  // ============================================================
  // POLLING WATCHER
  // ============================================================
  async function startWatcher() {
    if (watching) return;
    watching = true;

    setInterval(async () => {
      try {
        const snapshot = await getSnapshot();
        broadcast(snapshot);
      } catch (e) {
        console.error("Watcher error:", e);
      }
    }, 5000); // Poll every 5 seconds
  }

  // ============================================================
  // CRUD OPERATIONS
  // ============================================================

  // CREATE/UPDATE FILE
  async function saveFile(path, content, message = "update file") {
    let sha = null;

    // Check if file exists
    const check = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
      { headers }
    );

    if (check.status === 200) {
      const info = await check.json();
      sha = info.sha;
    }

    // Create or update
    const resp = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
      {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          content: Buffer.from(content).toString("base64"),
          sha
        })
      }
    );

    return resp.json();
  }

  // DELETE FILE
  async function removeFile(path, message = "delete file") {
    const getResp = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
      { headers }
    );

    if (getResp.status !== 200) {
      return { error: "File not found" };
    }

    const fileInfo = await getResp.json();

    const resp = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
      {
        method: "DELETE",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          sha: fileInfo.sha
        })
      }
    );

    return resp.json();
  }

  // MOVE/RENAME FILE
  async function moveFile(oldPath, newPath, message = "move file") {
    // Read old file
    const getResp = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${oldPath}`,
      { headers }
    );

    if (getResp.status !== 200) {
      return { error: "File not found" };
    }

    const fileInfo = await getResp.json();
    const content = Buffer.from(fileInfo.content, "base64").toString();

    // Create at new location
    await saveFile(newPath, content, message);

    // Delete old location
    await removeFile(oldPath, message);

    return { success: true, moved: `${oldPath} -> ${newPath}` };
  }

  // ============================================================
  // ROUTES
  // ============================================================

  // SSE STREAM - Live Updates
  if (req.method === "GET" && req.query.stream === "1") {
    startWatcher();

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    });

    subscribers.add(res);

    // Send initial structured snapshot
    const snapshot = await getSnapshot();
    res.write(`data: ${JSON.stringify(snapshot)}\n\n`);

    // Remove on disconnect
    req.on("close", () => {
      subscribers.delete(res);
    });

    return;
  }

  // GET - Read entire structure with SHA map
  if (req.method === "GET") {
    const snapshot = await getSnapshot();
    return res.status(200).json(snapshot);
  }

  // POST - Create new file
  if (req.method === "POST") {
    const { path, content, message } = req.body;
    
    if (!path || content === undefined) {
      return res.status(400).json({ error: "Missing path or content" });
    }

    const result = await saveFile(path, content, message || "create file");
    
    // Broadcast structured update
    const snapshot = await getSnapshot();
    broadcast(snapshot);

    return res.status(200).json(result);
  }

  // PUT - Update existing file or move
  if (req.method === "PUT") {
    const { path, content, message, action } = req.body;

    // Handle MOVE/RENAME
    if (action === "move" && req.body.newPath) {
      const result = await moveFile(path, req.body.newPath, message);
      
      const snapshot = await getSnapshot();
      broadcast(snapshot);
      
      return res.status(200).json(result);
    }

    // Handle UPDATE
    if (!path || content === undefined) {
      return res.status(400).json({ error: "Missing path or content" });
    }

    const result = await saveFile(path, content, message || "update file");
    
    // Broadcast structured update
    const snapshot = await getSnapshot();
    broadcast(snapshot);

    return res.status(200).json(result);
  }

  // DELETE - Remove file
  if (req.method === "DELETE") {
    const { path, message } = req.body;

    if (!path) {
      return res.status(400).json({ error: "Missing path" });
    }

    const result = await removeFile(path, message || "delete file");
    
    // Broadcast structured update
    const snapshot = await getSnapshot();
    broadcast(snapshot);

    return res.status(200).json(result);
  }

  return res.status(405).json({ error: "Method not allowed" });
}
