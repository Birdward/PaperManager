import { lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route, NavLink, useLocation, Navigate } from "react-router-dom";
import Library from "./pages/Library";
import PaperDetail from "./pages/PaperDetail";
import People from "./pages/People";
import Projects from "./pages/Projects";
import Settings from "./pages/Settings";
import BulkImport from "./pages/BulkImport";
import LiteratureSearch from "./pages/LiteratureSearch";
import Discover from "./pages/Discover";
import Blogs from "./pages/Blogs";
import BlogPostDetail from "./pages/BlogPostDetail";
import Teammates from "./pages/Teammates"; // page kept for direct navigation; no navbar link
import Venues from "./pages/Venues";
import MergeManager from "./pages/MergeManager";
import Login from "./pages/Login";
import AdminConsole from "./pages/AdminConsole";
import { SettingsProvider, useAppSettings } from "./contexts/SettingsContext";
import { UserProvider } from "./contexts/UserContext";
import { AuthProvider, useAuth } from "./contexts/AuthContext";
import ProtectedRoute from "./components/ProtectedRoute";
import ErrorBoundary from "./components/ErrorBoundary";
import Toaster from "./components/Toaster";

// Lazy-load Graph so react-force-graph (WebGL) doesn't run on initial page load
const Graph         = lazy(() => import("./pages/Graph"));
const Cypher        = lazy(() => import("./pages/Cypher"));
const KnowledgeChat = lazy(() => import("./pages/KnowledgeChat"));
const ConceptMap    = lazy(() => import("./pages/ConceptMap"));

function NavBar() {
  const { settings, update } = useAppSettings();
  const { logout, username } = useAuth();
  
  const handleLogout = () => {
    if (confirm("Are you sure you want to logout?")) {
      logout();
    }
  };
  
  const cls = ({ isActive }: { isActive: boolean }) =>
    `px-3 py-2 rounded text-sm font-medium transition-colors ${
      isActive
        ? "bg-violet-100 text-violet-700"
        : "text-gray-600 hover:text-gray-900 hover:bg-gray-100"
    }`;
  return (
    <nav className="border-b border-gray-200 bg-white px-6 py-3 flex items-center gap-2">
      <img src="/SecondBrainLogo.png" alt="PaperManager" className="h-14 mr-4 object-contain" />
      <NavLink to="/" end className={cls}>Library</NavLink>
      <NavLink to="/people" className={cls}>People</NavLink>
      <NavLink to="/projects" className={cls}>Projects</NavLink>
      <NavLink to="/graph" className={cls}>Graph</NavLink>
      <NavLink to="/cypher" className={cls}>Cypher</NavLink>
      <NavLink to="/knowledge" className={cls}>Knowledge</NavLink>
      <NavLink to="/discover" className={cls}>Discover</NavLink>
      <NavLink to="/literature" className={cls}>Literature</NavLink>
      <NavLink to="/blogs" className={cls}>Blogs</NavLink>
      <NavLink to="/admin" className={cls}>Admin</NavLink>
      <NavLink to="/settings" className={cls}>Settings</NavLink>
      <div className="ml-auto flex items-center gap-2">
        <button
          onClick={() => update({ debugMode: !settings.debugMode })}
          title={settings.debugMode ? "Debug mode ON — click to disable" : "Debug mode OFF — click to enable"}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-semibold border transition-colors ${
            settings.debugMode
              ? "bg-amber-500 border-amber-500 text-white"
              : "bg-white border-gray-300 text-gray-400 hover:border-gray-400 hover:text-gray-600"
          }`}
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
            <path fillRule="evenodd" d="M6.28 5.22a.75.75 0 0 1 0 1.06L2.56 10l3.72 3.72a.75.75 0 0 1-1.06 1.06L1 10.53a.75.75 0 0 1 0-1.06l4.22-4.25a.75.75 0 0 1 1.06 0Zm7.44 0a.75.75 0 0 1 1.06 0l4.22 4.22a.75.75 0 0 1 0 1.06l-4.22 4.22a.75.75 0 0 1-1.06-1.06L17.44 10l-3.72-3.72a.75.75 0 0 1 0-1.06ZM11.377 2.011a.75.75 0 0 1 .612.867l-2.5 14.5a.75.75 0 0 1-1.478-.255l2.5-14.5a.75.75 0 0 1 .866-.612Z" clipRule="evenodd" />
          </svg>
          {settings.debugMode && <span>DEBUG</span>}
        </button>
        <div className="flex items-center gap-2 ml-2 pl-2 border-l border-gray-300">
          <span className="text-sm text-gray-600">
            {username}
          </span>
          <button
            onClick={handleLogout}
            className="px-3 py-1.5 text-sm font-medium text-gray-600 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
            title="Logout"
          >
            Logout
          </button>
        </div>
      </div>
    </nav>
  );
}

function AppLayout() {
  const { pathname } = useLocation();
  const isKnowledge = pathname === "/knowledge";
  const isLogin = pathname === "/login";

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      {!isLogin && (
        isKnowledge ? (
          /* On /knowledge: navbar is fixed, hidden above viewport, slides down on hover */
          /* The translated navbar still occupies its layout box, so only the strip may take
             the pointer while it is hidden; otherwise the page's own top bar can't be clicked. */
          <div className="group fixed top-0 left-0 right-0 z-50 pointer-events-none">
            {/* Invisible trigger strip — always at y=0, captures hover */}
            <div className="h-1.5 w-full bg-violet-400/30 group-hover:opacity-0 transition-opacity pointer-events-auto" />
            <div className="-translate-y-full group-hover:translate-y-0 group-hover:pointer-events-auto transition-transform duration-200 shadow-lg">
              <NavBar />
            </div>
          </div>
        ) : (
          <NavBar />
        )
      )}
      <div className={isKnowledge ? "h-screen" : "flex-1 min-h-0 overflow-auto"}>
        <ErrorBoundary key={pathname}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/*" element={
            <ProtectedRoute>
              <Routes>
                <Route path="/" element={<Library />} />
                <Route path="/paper/:id" element={<PaperDetail />} />
                <Route path="/people" element={<People />} />
                <Route path="/projects" element={<Projects />} />
                <Route path="/projects/:id/map" element={<Suspense fallback={<div className="p-8 text-sm text-gray-400">Loading concept map…</div>}><ConceptMap /></Suspense>} />
                <Route path="/venues" element={<Venues />} />
                <Route path="/graph"   element={<Suspense fallback={<div className="p-8 text-sm text-gray-400">Loading graph…</div>}><Graph /></Suspense>} />
                <Route path="/cypher" element={<Suspense fallback={<div className="p-8 text-sm text-gray-400">Loading…</div>}><Cypher /></Suspense>} />
                <Route path="/knowledge" element={<Suspense fallback={<div className="p-8 text-sm text-gray-400">Loading…</div>}><KnowledgeChat /></Suspense>} />
                <Route path="/discover" element={<Discover />} />
                <Route path="/literature" element={<LiteratureSearch />} />
                <Route path="/bulk-import" element={<BulkImport />} />
                <Route path="/blogs" element={<Blogs />} />
                <Route path="/teammates" element={<Teammates />} />
                <Route path="/blogs/posts/:postId" element={<BlogPostDetail />} />
                <Route path="/admin" element={<AdminConsole />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="/merge" element={<MergeManager />} />
              </Routes>
            </ProtectedRoute>
          } />
        </Routes>
        </ErrorBoundary>
      </div>
        </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <SettingsProvider>
          <UserProvider>
            <AppLayout />
            <Toaster />
          </UserProvider>
        </SettingsProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
