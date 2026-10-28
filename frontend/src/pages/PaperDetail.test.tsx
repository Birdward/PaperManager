import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import * as client from '../api/client';
import type { Paper } from '../types';

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    apiFetch: vi.fn(),
    updatePaper: vi.fn(),
    deletePaper: vi.fn(),
    listReferences: vi.fn(),
    listAnnotations: vi.fn(),
    exportPaperMarkdown: vi.fn(),
    fetchPaperProjects: vi.fn().mockResolvedValue([]),
    listProjects: vi.fn().mockResolvedValue([]),
    fetchPaperInvolves: vi.fn().mockResolvedValue([]),
    fetchGraph: vi.fn().mockResolvedValue({ nodes: [], links: [] }),
    getPaperClaims: vi.fn().mockResolvedValue({ claims: [] }),
    getRelatedPapers: vi.fn().mockResolvedValue({ related: [], search_keywords: [] }),
    fetchFigures: vi.fn().mockResolvedValue([]),
    fetchTables: vi.fn().mockResolvedValue([]),
  };
});

vi.mock('react-router-dom', async (importActual) => {
  const actual = await importActual<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => vi.fn() };
});

// Mock heavy deps that aren't needed for these tests
vi.mock('../components/NoteEditor', () => ({ default: () => null }));
vi.mock('../components/ChatPanel', () => ({ default: () => null }));
vi.mock('../components/EditPaperModal', () => ({ default: () => null }));
vi.mock('../components/BookChapters', () => ({ default: () => null }));
vi.mock('../components/PdfAnnotator', () => ({ default: () => null, PdfAnnotatorHandle: null }));
vi.mock('../components/UploadConfirmModal', () => ({ default: () => null }));
vi.mock('../components/OnboardingModal', () => ({ default: () => null }));
vi.mock('../contexts/SettingsContext', () => ({
  useAppSettings: () => ({ settings: { debugMode: false } }),
}));
vi.mock('force-graph', () => ({ default: () => ({}) }));
vi.mock('../lib/notify', () => ({ notify: vi.fn() }));

const basePaper: Paper = {
  id: 'paper-1',
  title: 'Test Paper',
  created_at: '2024-01-01T00:00:00Z',
  reading_status: 'unread',
  rating: undefined,
  bookmarked: false,
  document_type: 'paper',
};

function setupMocks(paper: Paper = basePaper) {
  vi.mocked(client.apiFetch).mockImplementation((path: string) => {
    if (path === `/papers/${paper.id}`) return Promise.resolve(paper);
    if (path === `/papers/${paper.id}/authors`) return Promise.resolve([]);
    if (path === `/papers/${paper.id}/topics`) return Promise.resolve([]);
    if (path === `/papers/${paper.id}/tags`) return Promise.resolve([]);
    if (path === '/people') return Promise.resolve([]);
    return Promise.resolve([]);
  });
  vi.mocked(client.listReferences).mockResolvedValue({ references: [], cited_by: [] });
  vi.mocked(client.listAnnotations).mockResolvedValue([]);
  vi.mocked(client.updatePaper).mockResolvedValue(paper);
}

async function renderDetail(paper: Paper = basePaper) {
  const { default: PaperDetail } = await import('./PaperDetail');
  render(
    <MemoryRouter initialEntries={[`/paper/${paper.id}`]}>
      <Routes>
        <Route path="/paper/:id" element={<PaperDetail />} />
      </Routes>
    </MemoryRouter>
  );
  await screen.findByTitle('Click to cycle reading status');
}

describe('PaperDetail — reading status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMocks();
  });

  it('shows unread status badge', async () => {
    await renderDetail();
    expect(screen.getByTitle('Click to cycle reading status')).toHaveTextContent('Unread');
  });

  it('cycles status on click and calls API', async () => {
    const user = userEvent.setup();
    vi.mocked(client.apiFetch).mockImplementation((path, opts) => {
      if (opts?.method === 'PATCH') return Promise.resolve({ ...basePaper, reading_status: 'reading' });
      if (path === `/papers/${basePaper.id}`) return Promise.resolve(basePaper);
      if (path === `/papers/${basePaper.id}/authors`) return Promise.resolve([]);
      if (path === `/papers/${basePaper.id}/topics`) return Promise.resolve([]);
      if (path === `/papers/${basePaper.id}/tags`) return Promise.resolve([]);
      if (path === '/people') return Promise.resolve([]);
      return Promise.resolve([]);
    });

    await renderDetail();
    await user.click(screen.getByTitle('Click to cycle reading status'));

    await waitFor(() => {
      const calls = vi.mocked(client.apiFetch).mock.calls;
      const patchCall = calls.find(([, opts]) => opts?.method === 'PATCH');
      expect(patchCall).toBeTruthy();
      expect(patchCall![1]!.body).toBe(JSON.stringify({ reading_status: 'reading' }));
    });
  });

  it('shows optimistic update immediately', async () => {
    const user = userEvent.setup();
    let resolve: (v: unknown) => void;
    const pending = new Promise((res) => { resolve = res; });
    vi.mocked(client.apiFetch).mockImplementation((path, opts) => {
      if (opts?.method === 'PATCH') return pending as Promise<unknown>;
      if (path === `/papers/${basePaper.id}`) return Promise.resolve(basePaper);
      if (path === `/papers/${basePaper.id}/authors`) return Promise.resolve([]);
      if (path === `/papers/${basePaper.id}/topics`) return Promise.resolve([]);
      if (path === `/papers/${basePaper.id}/tags`) return Promise.resolve([]);
      if (path === '/people') return Promise.resolve([]);
      return Promise.resolve([]);
    });

    await renderDetail();
    await user.click(screen.getByTitle('Click to cycle reading status'));

    // Should show Reading immediately, before API resolves
    expect(screen.getByTitle('Click to cycle reading status')).toHaveTextContent('Reading');
    resolve!({ ...basePaper, reading_status: 'reading' });
  });

  // Regression: when the PATCH fails (e.g. the backend returned HTTP 500 from a
  // broken Cypher query), the optimistic change must roll back to the original
  // status — this is the "clicking read/unread does nothing" symptom.
  it('reverts status on API error', async () => {
    const user = userEvent.setup();
    vi.mocked(client.apiFetch).mockImplementation((path, opts) => {
      if (opts?.method === 'PATCH') return Promise.reject(new Error('API 500'));
      if (path === `/papers/${basePaper.id}`) return Promise.resolve(basePaper);
      if (path === `/papers/${basePaper.id}/authors`) return Promise.resolve([]);
      if (path === `/papers/${basePaper.id}/topics`) return Promise.resolve([]);
      if (path === `/papers/${basePaper.id}/tags`) return Promise.resolve([]);
      if (path === '/people') return Promise.resolve([]);
      return Promise.resolve([]);
    });

    await renderDetail();
    await user.click(screen.getByTitle('Click to cycle reading status'));

    // After the failed PATCH it must fall back to the original "Unread".
    await waitFor(() => {
      expect(screen.getByTitle('Click to cycle reading status')).toHaveTextContent('Unread');
    });
  });
});

describe('PaperDetail — bookmark', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMocks();
  });

  it('toggles bookmark on click', async () => {
    const user = userEvent.setup();
    vi.mocked(client.apiFetch).mockImplementation((path, opts) => {
      if (opts?.method === 'PATCH') return Promise.resolve({ ...basePaper, bookmarked: true });
      if (path === `/papers/${basePaper.id}`) return Promise.resolve(basePaper);
      if (path === `/papers/${basePaper.id}/authors`) return Promise.resolve([]);
      if (path === `/papers/${basePaper.id}/topics`) return Promise.resolve([]);
      if (path === `/papers/${basePaper.id}/tags`) return Promise.resolve([]);
      if (path === '/people') return Promise.resolve([]);
      return Promise.resolve([]);
    });

    await renderDetail();
    await user.click(screen.getByTitle('Bookmark'));

    await waitFor(() => {
      const calls = vi.mocked(client.apiFetch).mock.calls;
      const patchCall = calls.find(([, opts]) => opts?.method === 'PATCH');
      expect(patchCall![1]!.body).toBe(JSON.stringify({ bookmarked: true }));
    });
  });
});

describe('PaperDetail — star rating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMocks();
  });

  it('sets rating when star clicked', async () => {
    const user = userEvent.setup();
    vi.mocked(client.apiFetch).mockImplementation((path, opts) => {
      if (opts?.method === 'PATCH') return Promise.resolve({ ...basePaper, rating: 4 });
      if (path === `/papers/${basePaper.id}`) return Promise.resolve(basePaper);
      if (path === `/papers/${basePaper.id}/authors`) return Promise.resolve([]);
      if (path === `/papers/${basePaper.id}/topics`) return Promise.resolve([]);
      if (path === `/papers/${basePaper.id}/tags`) return Promise.resolve([]);
      if (path === '/people') return Promise.resolve([]);
      return Promise.resolve([]);
    });

    await renderDetail();
    await user.click(screen.getByTitle('Rate 4 stars'));

    await waitFor(() => {
      const calls = vi.mocked(client.apiFetch).mock.calls;
      const patchCall = calls.find(([, opts]) => opts?.method === 'PATCH');
      expect(patchCall![1]!.body).toBe(JSON.stringify({ rating: 4 }));
    });
  });
});

describe('PaperDetail — document type', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMocks();
  });

  it('changes document type immediately (optimistic) and calls API', async () => {
    const user = userEvent.setup();
    vi.mocked(client.updatePaper).mockResolvedValue({ ...basePaper, document_type: 'book' });

    // Navigate to the Metadata tab
    const { default: PaperDetail } = await import('./PaperDetail');
    render(
      <MemoryRouter initialEntries={[`/paper/${basePaper.id}`]}>
        <Routes>
          <Route path="/paper/:id" element={<PaperDetail />} />
        </Routes>
      </MemoryRouter>
    );
    await screen.findByTitle('Click to cycle reading status');

    // Open Metadata tab
    await user.click(screen.getByText('Metadata'));

    // Find and change document type select
    const docTypeSelect = await screen.findByDisplayValue('📄 Paper');
    await user.selectOptions(docTypeSelect, '📚 Book');

    await waitFor(() => {
      expect(client.updatePaper).toHaveBeenCalledWith(
        basePaper.id,
        expect.objectContaining({ document_type: 'book' })
      );
    });

    // Optimistic: select should show Book immediately
    expect(docTypeSelect).toHaveValue('book');
  });

  it('reverts document type on API error', async () => {
    const user = userEvent.setup();
    vi.mocked(client.updatePaper).mockRejectedValue(new Error('Server error'));

    const { default: PaperDetail } = await import('./PaperDetail');
    render(
      <MemoryRouter initialEntries={[`/paper/${basePaper.id}`]}>
        <Routes>
          <Route path="/paper/:id" element={<PaperDetail />} />
        </Routes>
      </MemoryRouter>
    );
    await screen.findByTitle('Click to cycle reading status');
    await user.click(screen.getByText('Metadata'));

    const docTypeSelect = await screen.findByDisplayValue('📄 Paper');
    await user.selectOptions(docTypeSelect, '📚 Book');

    await waitFor(() => {
      expect(docTypeSelect).toHaveValue('paper');
    });
  });
});
