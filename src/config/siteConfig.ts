import defaultConfig from "../../config.example.json";
import type { SiteConfig } from "./types";

const userConfigModules = import.meta.glob<SiteConfig>("../../config.json", {
  eager: true,
  import: "default",
});

const userConfig = Object.values(userConfigModules)[0];

export const siteConfig: SiteConfig = {
  ...(defaultConfig as SiteConfig),
  ...(userConfig ?? {}),
};
