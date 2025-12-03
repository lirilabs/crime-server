import fetch from "node-fetch";

let subscribers = new Set();       
let lastSnapshot = null;           // Cached structure+SHA map
let lastSentJSON = "";             // For SSE dedup
let watching = false;              // Ensure watcher runs once

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-cache");

  if (req.method === "OPTIONS") return res.status(200).end();

  const owner = "lirilabs";
  const repo = "crime";
  const token = process.env.GITHUB_TOKEN;

  const baseHeaders = {
    Authorization: `token ${token}`,
    "User-Agent": "live-github-fs",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache"
  };

  // --------------------------------------------------------------
  // Recursive GitHub Folder Reader + SHA Snapshot
  async function readFolder(path = "") {
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
    const resp = await fetch(url, { headers: baseHeaders });
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

  // --------------------------------------------------------------
  // GET FULL SNAPSHOT (structure + SHA-map)
  async function getSnapshot() {
    const structure = await readFolder("");
    const shaMap = {};

    function mapSHA(tree) {
      tree.forEach(n => {
        shaMap[n.path] = n.sha;
        if (n.type === "directory") mapSHA(n.children);
      });
    }
    mapSHA(structure);

    return { structure, shaMap };
  }

  // --------------------------------------------------------------
  // Live Push to all SSE subscribers
  function pushUpdate(data) {
    const json = JSON.stringify(data);
    if (json === lastSentJSON) return;
    lastSentJSON = json;

    for (const res of subscribers) {
      try { res.write(`data: ${json}\n\n`); }
      catch { }
    }
  }

  // --------------------------------------------------------------
  // Watcher loop (GitHub polling)
  async function startWatcher() {
    if (watching) return;
    watching = true;

    setInterval(async () => {
      try {
        const snapshot = await getSnapshot();

        if (!lastSnapshot) {
          lastSnapshot = snapshot;
          pushUpdate(snapshot);
          return;
        }

        let changed = false;

        // Compare SHA maps
        for (const path of Object.keys(snapshot.shaMap)) {
          if (snapshot.shaMap[path] !== lastSnapshot.shaMap[path]) {
            changed = true;
            break;
          }
        }

        if (changed) {
          lastSnapshot = snapshot;
          pushUpdate(snapshot);
        }

      } catch (e) {
        console.error("Watcher error:", e);
      }
    }, 10000); // check every 10s
  }

  startWatcher();

  // --------------------------------------------------------------
  // CRUD UTILITIES
  async function writeFile(path, content, message = "update") {
    let sha = null;

    const check = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
      { headers: baseHeaders }
    );

    if (check.status === 200) {
      const info = await check.json();
      sha = info.sha;
    }

    const resp = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
      {
        method: "PUT",
        headers: { ...baseHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          content: Buffer.from(content).toString("base64"),
          sha
        })
      }
    );

    return resp.json();
  }

  async function deleteFile(path, message = "delete") {
    const getResp = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
      { headers: baseHeaders }
    );

    if (getResp.status !== 200) return { error: "File not found" };

    const fileInfo = await getResp.json();

    const resp = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
      {
        method: "DELETE",
        headers: { ...baseHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          sha: fileInfo.sha
        })
      }
    );

    return resp.json();
  }

  // --------------------------------------------------------------
  // SSE Connection (stream=1)
  if (req.method === "GET" && req.query.stream === "1") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive"
    });

    subscribers.add(res);

    // Send initial data
    if (lastSnapshot)
      res.write(`data: ${JSON.stringify(lastSnapshot)}\n\n`);

    // Remove client on disconnect
    req.on("close", () => {
      subscribers.delete(res);
    });

    return;
  }

  // --------------------------------------------------------------
  // Normal GET = return structure instantly
  if (req.method === "GET") {
    const snapshot = await getSnapshot();
    lastSnapshot = snapshot;
    return res.status(200).json(snapshot);
  }

  // --------------------------------------------------------------
  // POST = create
  if (req.method === "POST") {
    const { path, content, message } = req.body;
    const out = await writeFile(path, content, message);

    // Push live update
    const snapshot = await getSnapshot();
    lastSnapshot = snapshot;
    pushUpdate(snapshot);

    return res.status(200).json(out);
  }

  // --------------------------------------------------------------
  // PUT = update
  if (req.method === "PUT") {
    const { path, content, message } = req.body;
    const out = await writeFile(path, content, message);

    // Push live update
    const snapshot = await getSnapshot();
    lastSnapshot = snapshot;
    pushUpdate(snapshot);

    return res.status(200).json(out);
  }

  // --------------------------------------------------------------
  // DELETE
  if (req.method === "DELETE") {
    const { path, message } = req.body;
    const out = await deleteFile(path, message);

    // Push live update
    const snapshot = await getSnapshot();
    lastSnapshot = snapshot;
    pushUpdate(snapshot);

    return res.status(200).json(out);
  }

  return res.status(405).json({ error: "Method not allowed" });
}
