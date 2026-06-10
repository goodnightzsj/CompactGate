import { useDocumentTitle } from "../hooks/useDocumentTitle.js";
import { useThemeMode } from "../hooks/useThemeMode.js";
import { StudioSidebar } from "../layout/StudioSidebar.js";
import { ProfileDeleteDialogHost } from "./ProfileDeleteDialogHost.js";
import { StudioPageOutlet } from "./StudioPageOutlet.js";
import { useStudioNavigation } from "./useStudioNavigation.js";
import { useStudioPageModels } from "./useStudioPageModels.js";

export function StudioApp() {
  const navigation = useStudioNavigation();
  const [themeMode, setThemeMode] = useThemeMode();
  const pageModels = useStudioPageModels({
    currentPage: navigation.currentPage,
    healthMode: navigation.healthMode,
    pageMode: navigation.pageMode
  });
  const sidebarPage = navigation.healthMode ? "dashboard" : navigation.currentPage;

  useDocumentTitle(navigation.pageMode);

  return (
    <div className="app-shell">
      <StudioSidebar
        currentPage={sidebarPage}
        onNavigate={navigation.navigateTo}
        health={pageModels.sidebarHealth}
        themeMode={themeMode}
        onThemeModeChange={setThemeMode}
      />

      <main className="main-content">
        <StudioPageOutlet {...pageModels.pageOutlet} />
      </main>

      {pageModels.profileDeleteDialog && (
        <ProfileDeleteDialogHost {...pageModels.profileDeleteDialog} />
      )}
    </div>
  );
}
