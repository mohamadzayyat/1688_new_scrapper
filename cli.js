#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { getItemDetailById } from "./scrape.js";
import { searchOffers } from "./search.js";
import { login1688 } from "./auth.js";

function usage(exitCode = 1) {
  console.error(`Usage:
  # Offer detail — TMAPI shape (lang: zh | en)
  node cli.js <offerId> [--lang zh|en] [--out path.json] [--headed]

  # Keyword search with pagination (lang: zh | en)
  node cli.js --search <keyword> [--page N] [--lang zh|en] [--out path.json] [--headed]

  # Save a 1688 login session (needed when search asks for login)
  node cli.js --login

Examples:
  node cli.js 874039857500
  node cli.js 874039857500 --lang en
  node cli.js --search router --lang en
  node cli.js --search router --page 2 --out output/router-p2.json
  node cli.js --login`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = {
    mode: "offer",
    offerId: null,
    keyword: null,
    page: 1,
    lang: "zh",
    out: null,
    headed: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") usage(0);
    else if (a === "--headed") args.headed = true;
    else if (a === "--login") args.mode = "login";
    else if (a === "--lang" || a === "-l") {
      args.lang = String(argv[++i] || "").toLowerCase();
      if (!["zh", "en", "english", "chinese"].includes(args.lang)) usage();
      if (args.lang === "english") args.lang = "en";
      if (args.lang === "chinese") args.lang = "zh";
    } else if (a === "--search" || a === "-s") {
      args.mode = "search";
      args.keyword = argv[++i];
      if (!args.keyword) usage();
    } else if (a === "--page" || a === "-p") {
      args.page = Number(argv[++i]);
      if (!Number.isFinite(args.page) || args.page < 1) usage();
    } else if (a === "--out" || a === "-o") {
      args.out = argv[++i];
      if (!args.out) usage();
    } else if (!a.startsWith("-") && !args.offerId && args.mode === "offer") {
      args.offerId = a.replace(/\.html$/i, "").replace(/^.*\//, "");
    } else {
      console.error(`Unknown argument: ${a}`);
      usage();
    }
  }

  if (args.mode === "offer") {
    if (!args.offerId || !/^\d+$/.test(args.offerId)) {
      console.error("Error: offer ID must be a number (e.g. 874039857500)");
      usage();
    }
  } else if (args.mode === "search" && !args.keyword?.trim()) {
    console.error("Error: search keyword is required");
    usage();
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.mode === "login") {
    const path = await login1688();
    console.log(JSON.stringify({ ok: true, authPath: path }, null, 2));
    return;
  }

  const data =
    args.mode === "search"
      ? await searchOffers(args.keyword, {
          page: args.page,
          headed: args.headed,
          lang: args.lang,
        })
      : await getItemDetailById(args.offerId, {
          headed: args.headed,
          language: args.lang,
        });

  if (args.mode === "offer" && data?.code && data.code !== 200) {
    console.error(`Failed: ${data.msg || "unknown error"}`);
    process.exit(1);
  }

  const json = JSON.stringify(data, null, 2);

  if (args.out) {
    const outPath = resolve(args.out);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, json + "\n", "utf8");
    console.error(`Wrote ${outPath}`);
  }

  process.stdout.write(json + "\n");
}

main().catch((err) => {
  console.error(`Failed: ${err.message}`);
  process.exit(1);
});
