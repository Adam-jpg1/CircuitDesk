import { useEffect } from 'react';
import { useHashRoute, ErrorBoundary, ToastHost } from '../ui/primitives';
import { Dashboard } from '../dashboard/Dashboard';
import { EditorShell } from '../editor/EditorShell';
import { ImportWizard } from '../import/ImportWizard';
import { CustomPartsPage } from '../custom-parts/CustomPartsPage';
import { AboutPage } from './AboutPage';
import { useCustomPartsStore } from '../custom-parts/customPartsStore';

export function App() {
  const route = useHashRoute();

  // Load the shared custom part library once at startup.
  useEffect(() => {
    void useCustomPartsStore.getState().refresh();
  }, []);

  const editorMatch = /^#\/editor\/(.+)$/.exec(route);

  return (
    <>
      {editorMatch ? (
        <ErrorBoundary name="editor" key={editorMatch[1]}>
          <EditorShell projectId={editorMatch[1]} />
        </ErrorBoundary>
      ) : route.startsWith('#/import') ? (
        <ErrorBoundary name="import wizard">
          <ImportWizard />
        </ErrorBoundary>
      ) : route.startsWith('#/custom-parts') ? (
        <ErrorBoundary name="custom parts library">
          <CustomPartsPage />
        </ErrorBoundary>
      ) : route.startsWith('#/about') ? (
        <ErrorBoundary name="about page">
          <AboutPage />
        </ErrorBoundary>
      ) : (
        <ErrorBoundary name="dashboard">
          <Dashboard />
        </ErrorBoundary>
      )}
      <ToastHost />
    </>
  );
}
