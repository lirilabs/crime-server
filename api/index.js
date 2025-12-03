import fetch from "node-fetch";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  const owner = "lirilabs";
  const repo = "crime";
  const token = process.env.GITHUB_TOKEN;

  const baseHeaders = {
    Authorization: `token ${token}`,
    "User-Agent": "crud-github-api-reader"
  };

  // -------------------------------------------------------------------
  // READ: recursive folder reader
  async function readFolder(path = "") {
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
    const resp = await fetch(url, { headers: baseHeaders });
    const data = await resp.json();

    if (!Array.isArray(data)) return { error: true, raw: data };

    const result = [];
    for (const item of data) {
      if (item.type === "dir") {
        result.push({
          name: item.name,
          type: "directory",
          path: item.path,
          children: await readFolder(item.path)
        });
      } else {
        const contentResp = await fetch(item.download_url);
        const content = await contentResp.text();

        result.push({
          name: item.name,
          type: "file",
          path: item.path,
          content
        });
      }
    }
    return result;
  }

  // -------------------------------------------------------------------
  // CREATE / UPDATE: upsert file
  async function writeFile(path, content, message = "update from API") {
    // Must get existing SHA if updating
    let sha = null;

    const checkResp = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
      { headers: baseHeaders }
    );

    if (checkResp.status === 200) {
      const fileInfo = await checkResp.json();
      sha = fileInfo.sha;
    }

    const body = {
      message,
      content: Buffer.from(content).toString("base64"),
      sha
    };

    const resp = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
      {
        method: "PUT",
        headers: {
          ...baseHeaders,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      }
    );

    return resp.json();
  }

  // -------------------------------------------------------------------
  // DELETE file
  async function deleteFile(path, message = "delete file") {
    const getResp = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
      { headers: baseHeaders }
    );

    if (getResp.status !== 200) {
      return { error: "File not found" };
    }

    const fileInfo = await getResp.json();

    const resp = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
      {
        method: "DELETE",
        headers: {
          ...baseHeaders,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          message,
          sha: fileInfo.sha
        })
      }
    );

    return resp.json();
  }

  // -------------------------------------------------------------------
  // ROUTING LAYER
  try {
    if (req.method === "GET") {
      const tree = await readFolder("");
      return res.status(200).json({ structure: tree });
    }

    if (req.method === "POST") {
      const { path, content, message } = req.body;
      const out = await writeFile(path, content, message);
      return res.status(200).json(out);
    }

    if (req.method === "PUT") {
      const { path, content, message } = req.body;
      const out = await writeFile(path, content, message);
      return res.status(200).json(out);
    }

    if (req.method === "DELETE") {
      const { path, message } = req.body;
      const out = await deleteFile(path, message);
      return res.status(200).json(out);
    }

    res.status(405).json({ error: "Method not allowed" });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
