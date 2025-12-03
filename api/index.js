import fetch from "node-fetch";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const owner = "lirilabs";
    const repo = "crime";

    const headers = {
      Authorization: `token ${process.env.GITHUB_TOKEN}`,
      "User-Agent": "simple-folder-reader"
    };

    // Fetch file content if needed
    async function readFileContent(item) {
      try {
        const resp = await fetch(item.download_url);
        const text = await resp.text();

        if (item.name.endsWith(".json")) {
          try {
            return JSON.parse(text);
          } catch {
            return { invalidJson: true, raw: text };
          }
        }

        return text;
      } catch (e) {
        return { error: e.message };
      }
    }

    // Recursively read folder
    async function readFolder(path = "") {
      const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
      const resp = await fetch(url, { headers });
      const data = await resp.json();

      if (!Array.isArray(data)) {
        return { error: true, raw: data };
      }

      const results = [];

      for (const item of data) {
        if (item.type === "dir") {
          results.push({
            name: item.name,
            type: "directory",
            path: item.path,
            children: await readFolder(item.path)
          });
        } else {
          results.push({
            name: item.name,
            type: "file",
            path: item.path,
            download_url: item.download_url,
            content: await readFileContent(item)
          });
        }
      }

      return results;
    }

    const tree = await readFolder("");

    return res.status(200).json({
      repo: `${owner}/${repo}`,
      structure: tree
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
