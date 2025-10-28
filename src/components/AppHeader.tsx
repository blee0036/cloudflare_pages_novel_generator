import { Link } from "react-router-dom";
import { DarkModeToggle } from "./DarkModeToggle";
import { siteConfig } from "../config/siteConfig";

export const AppHeader: React.FC = () => {
  const { siteName, shortName } = siteConfig;
  return (
    <header className="app-header">
      <div className="app-header-inner">
        <Link to="/" className="brand" aria-label={`返回${siteName}主页`}>
          <span className="brand-logo">{shortName}</span>
          <span>{siteName}</span>
        </Link>
        <DarkModeToggle />
      </div>
    </header>
  );
};
