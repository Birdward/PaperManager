import { useState, useEffect } from "react";
import { apiFetch, type ProjectMember, getProjectMembers } from "../api/client";
import { useAuth } from "../contexts/AuthContext";
import UserManagement from "../components/UserManagement";
import ProjectMembers from "../components/ProjectMembers";

interface User {
  name: string;
  id: string;
  color?: string;
  is_admin?: boolean;
  paper_count?: number;
  conversation_count?: number;
  note_count?: number;
  connection_count?: number;
}

interface Project {
  id: string;
  name: string;
  description?: string;
  status?: string;
  paper_count?: number;
}

interface ProjectMembership {
  project_id: string;
  project_name: string;
  members: ProjectMember[];
}

export default function AdminConsole() {
  const { username } = useAuth();
  const [users, setUsers] = useState<User[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [memberships, setMemberships] = useState<ProjectMembership[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"overview" | "users" | "projects">("overview");
  const [expandedProject, setExpandedProject] = useState<string | null>(null);

  const canViewAdmin = username?.toLowerCase() === "niklas";

  useEffect(() => {
    if (canViewAdmin) {
      loadData();
    }
  }, [canViewAdmin]);

  async function loadData() {
    setLoading(true);
    try {
      const [usersData, projectsData] = await Promise.all([
        apiFetch<User[]>("/users"),
        apiFetch<Project[]>("/projects"),
      ]);
      setUsers(usersData);
      setProjects(projectsData);

      // Load memberships for all projects
      const membershipData = await Promise.all(
        projectsData.map(async (p) => {
          try {
            const members = await getProjectMembers(p.id);
            return { project_id: p.id, project_name: p.name, members };
          } catch {
            return { project_id: p.id, project_name: p.name, members: [] };
          }
        })
      );
      setMemberships(membershipData);
    } catch (err) {
      console.error("Failed to load admin data:", err);
    } finally {
      setLoading(false);
    }
  }

  function getUserColor(name: string, explicitColor?: string): string {
    if (explicitColor) return explicitColor;
    if (!name?.trim()) return "#94a3b8";
    const palette = ["#7c3aed", "#2563eb", "#0d9488", "#ea580c", "#db2777"];
    const hash = [...name.trim().toLowerCase()].reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
    return palette[hash % palette.length];
  }

  const totalPapers = users.reduce((sum, u) => sum + (u.paper_count || 0), 0);
  const totalConversations = users.reduce((sum, u) => sum + (u.conversation_count || 0), 0);
  const totalNotes = users.reduce((sum, u) => sum + (u.note_count || 0), 0);

  if (!canViewAdmin) {
    return <div className="min-h-screen bg-white" />;
  }

  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Admin Console</h1>
        <p className="text-sm text-gray-500 mt-1">Multi-user platform management dashboard</p>
      </div>

      {/* Tab Navigation */}
      <div className="border-b border-gray-200 mb-6">
        <div className="flex gap-6">
          {(["overview", "users", "projects"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`pb-3 px-1 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab
                  ? "border-violet-600 text-violet-600"
                  : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
              }`}
            >
              {tab === "overview" ? "Overview" : tab === "users" ? "Users" : "Projects"}
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <div className="flex justify-center py-12">
          <svg className="animate-spin h-8 w-8 text-violet-400" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
          </svg>
        </div>
      )}

      {!loading && (
        <>
          {/* Overview Tab */}
          {activeTab === "overview" && (
            <div className="space-y-6">
              {/* Stats Grid */}
              <div className="grid grid-cols-4 gap-4">
                <div className="bg-white border border-gray-200 rounded-xl p-5">
                  <p className="text-3xl font-bold text-violet-700">{users.length}</p>
                  <p className="text-sm text-gray-500 mt-1">Total Users</p>
                </div>
                <div className="bg-white border border-gray-200 rounded-xl p-5">
                  <p className="text-3xl font-bold text-blue-700">{projects.length}</p>
                  <p className="text-sm text-gray-500 mt-1">Projects</p>
                </div>
                <div className="bg-white border border-gray-200 rounded-xl p-5">
                  <p className="text-3xl font-bold text-teal-700">{totalPapers}</p>
                  <p className="text-sm text-gray-500 mt-1">Papers</p>
                </div>
                <div className="bg-white border border-gray-200 rounded-xl p-5">
                  <p className="text-3xl font-bold text-orange-700">{totalConversations + totalNotes}</p>
                  <p className="text-sm text-gray-500 mt-1">Conversations & Notes</p>
                </div>
              </div>

              {/* Recent Activity */}
              <div className="bg-white border border-gray-200 rounded-xl p-6">
                <h3 className="text-lg font-semibold text-gray-900 mb-4">User Activity</h3>
                <div className="space-y-3">
                  {users.slice(0, 5).map((user) => {
                    const color = getUserColor(user.name, user.color);
                    return (
                      <div key={user.id} className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
                        <div className="flex items-center gap-3">
                          <div className="w-3 h-3 rounded-full" style={{ backgroundColor: color }} />
                          <span className="font-medium text-gray-900">{user.name}</span>
                          {user.is_admin && (
                            <span className="text-xs px-2 py-0.5 bg-violet-100 text-violet-700 rounded-full">Admin</span>
                          )}
                        </div>
                        <div className="flex gap-4 text-sm text-gray-500">
                          <span>{user.paper_count || 0} papers</span>
                          <span>{user.conversation_count || 0} convs</span>
                          <span>{user.note_count || 0} notes</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Project Membership Matrix */}
              <div className="bg-white border border-gray-200 rounded-xl p-6">
                <h3 className="text-lg font-semibold text-gray-900 mb-4">Project Membership Matrix</h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-200">
                        <th className="text-left py-2 px-3 font-medium text-gray-700">Project</th>
                        {users.map((user) => (
                          <th key={user.id} className="text-center py-2 px-2 font-medium text-gray-700 min-w-[60px]">
                            <div className="flex flex-col items-center gap-1">
                              <div
                                className="w-2.5 h-2.5 rounded-full"
                                style={{ backgroundColor: getUserColor(user.name, user.color) }}
                              />
                              <span className="text-xs">{user.name.slice(0, 8)}</span>
                            </div>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {memberships.map((pm) => (
                        <tr key={pm.project_id} className="border-b border-gray-100 hover:bg-gray-50">
                          <td className="py-2 px-3 font-medium text-gray-900">{pm.project_name}</td>
                          {users.map((user) => {
                            const member = pm.members.find(m => m.username.toLowerCase() === user.name.toLowerCase());
                            return (
                              <td key={user.id} className="text-center py-2 px-2">
                                {member && (
                                  <span className={`text-xs px-2 py-0.5 rounded-full ${
                                    member.role === "admin" ? "bg-violet-100 text-violet-700" :
                                    member.role === "write" ? "bg-blue-100 text-blue-700" :
                                    "bg-gray-100 text-gray-600"
                                  }`}>
                                    {member.role[0].toUpperCase()}
                                  </span>
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* Users Tab */}
          {activeTab === "users" && (
            <UserManagement />
          )}

          {/* Projects Tab */}
          {activeTab === "projects" && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {projects.map((project) => {
                const projectMembers = memberships.find(m => m.project_id === project.id)?.members || [];
                return (
                  <div key={project.id} className="bg-white border border-gray-200 rounded-xl p-5">
                    <div className="flex items-start justify-between mb-3">
                      <div>
                        <h3 className="font-semibold text-gray-900">{project.name}</h3>
                        {project.description && (
                          <p className="text-sm text-gray-500 mt-1">{project.description}</p>
                        )}
                      </div>
                      <span className={`text-xs px-2 py-1 rounded-full ${
                        project.status === "active" ? "bg-green-100 text-green-700" :
                        project.status === "paused" ? "bg-yellow-100 text-yellow-700" :
                        "bg-gray-100 text-gray-600"
                      }`}>
                        {project.status}
                      </span>
                    </div>

                    <div className="flex items-center gap-4 text-sm text-gray-500 mb-3">
                      <span>{project.paper_count || 0} papers</span>
                      <span>{projectMembers.length} members</span>
                    </div>

                    {projectMembers.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {projectMembers.map((member) => {
                          const user = users.find(u => u.name.toLowerCase() === member.username.toLowerCase());
                          const color = getUserColor(member.username, user?.color);
                          return (
                            <div key={member.username} className="flex items-center gap-1.5 bg-gray-50 px-2 py-1 rounded-full">
                              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
                              <span className="text-xs text-gray-700">{member.username}</span>
                              <span className="text-[10px] text-gray-500">({member.role})</span>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    <div className="mt-4 pt-3 border-t border-gray-100">
                      <button
                        onClick={() =>
                          setExpandedProject(expandedProject === project.id ? null : project.id)
                        }
                        className="text-xs font-medium text-violet-700 hover:text-violet-800 transition-colors"
                      >
                        {expandedProject === project.id ? "Hide member management" : "Manage members"}
                      </button>
                      {expandedProject === project.id && (
                        <div className="mt-3">
                          <ProjectMembers
                            projectId={project.id}
                            currentUser={username ?? ""}
                            userRole="admin"
                          />
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

        </>
      )}
    </div>
  );
}
