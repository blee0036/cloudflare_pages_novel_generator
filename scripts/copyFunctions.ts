import path from "node:path";
import fs from "fs-extra";

async function copyFunctions() {
  const root = path.resolve(__dirname, "..");
  const source = path.join(root, "functions");
  const destination = path.join(root, "dist", "functions");

  const distExists = await fs.pathExists(path.join(root, "dist"));
  const functionsExists = await fs.pathExists(source);

  if (!distExists || !functionsExists) {
    return;
  }

  await fs.remove(destination);
  await fs.copy(source, destination);
  console.log("✔ 已复制 functions/ 到 dist/functions");
}

copyFunctions().catch((error) => {
  console.error("复制 functions 目录失败", error);
  process.exitCode = 1;
});
