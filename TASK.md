# NemoStage: PPTX Ingestion & React Rendering - Task Breakdown

## Context
NemoStage is a **Live Presentation Co-Pilot** that recreates PowerPoint presentations in a React-based web presenter. This task breakdown focuses specifically on the **PPTX ingestion and React recreation** subsystem, which forms the foundation for the Live Presentation State Engine.

**Technology Stack**: Electron + Vite + TypeScript + React

**Key Constraint**: Security-first architecture with `contextIsolation: true` and `nodeIntegration: false`

---

## **PHASE 1: Foundation - Secure Electron-Vite-React Architecture**

### Task 1.1: Electron-Vite-TypeScript Project Initialization
**Objective**: Set up the Electron-Vite boilerplate with TypeScript support

**Subtasks**:
- [ ] Initialize project using Electron-Vite with TypeScript template
  ```bash
  npm create @quick-start/electron -- nemostage --template react-ts
  ```
- [ ] Verify project structure includes:
  - `src/main/` - Main process (Node.js environment)
  - `src/preload/` - Preload script (bridge context)
  - `src/renderer/` - React app (browser environment)
- [ ] Configure `vite.config.ts` for proper path aliases
- [ ] Install core dependencies:
  ```json
  {
    "electron": "^28.0.0",
    "vite": "^5.0.0",
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "typescript": "^5.3.0"
  }
  ```
- [ ] Run dev build to verify hot reload works

**Acceptance Criteria**:
- `npm run dev` launches Electron window with React app
- TypeScript compilation has no errors
- Hot module replacement (HMR) works in renderer process

**Technical Dependencies**: None

---

### Task 1.2: Security-First IPC Bridge (Main ↔ Renderer Communication)
**Objective**: Establish type-safe, secure communication between Electron main process and React renderer

**Subtasks**:
- [ ] Configure `BrowserWindow` in `src/main/index.ts`:
  ```typescript
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '../preload/index.js')
    }
  })
  ```
- [ ] Create typed IPC API contract in `src/preload/index.d.ts`:
  ```typescript
  interface ElectronAPI {
    selectPPTX: () => Promise<string | null>;
    extractPPTX: (filePath: string) => Promise<ExtractionResult>;
    getSlideImage: (slideIndex: number) => Promise<string>;
    getSlideData: (slideIndex: number) => Promise<SlideData>;
  }
  
  declare global {
    interface Window {
      electronAPI: ElectronAPI;
    }
  }
  ```
- [ ] Implement `contextBridge` in `src/preload/index.ts`:
  ```typescript
  import { contextBridge, ipcRenderer } from 'electron';
  
  contextBridge.exposeInMainWorld('electronAPI', {
    selectPPTX: () => ipcRenderer.invoke('dialog:openFile'),
    extractPPTX: (filePath: string) => ipcRenderer.invoke('pptx:extract', filePath),
    getSlideImage: (index: number) => ipcRenderer.invoke('pptx:getImage', index),
    getSlideData: (index: number) => ipcRenderer.invoke('pptx:getData', index)
  });
  ```
- [ ] Set up IPC handlers in `src/main/ipcHandlers.ts`:
  ```typescript
  ipcMain.handle('dialog:openFile', async () => { /* ... */ });
  ipcMain.handle('pptx:extract', async (event, filePath) => { /* ... */ });
  ```

**Acceptance Criteria**:
- React components can call `window.electronAPI` methods
- TypeScript autocomplete works for all API methods
- Main process cannot be accessed directly from renderer
- No console warnings about `contextBridge` or security

**Technical Dependencies**: Task 1.1

---

### Task 1.3: Temporary Workspace File System
**Objective**: Create and manage the `/temp_presentation` directory for extracted PPTX data

**Subtasks**:
- [ ] Create `src/main/services/workspaceManager.ts`
- [ ] Implement `initializeWorkspace()`:
  ```typescript
  import { app } from 'electron';
  import fs from 'fs-extra';
  import path from 'path';
  
  const WORKSPACE_DIR = path.join(app.getPath('userData'), 'temp_presentation');
  
  export async function initializeWorkspace(sessionId: string) {
    const sessionDir = path.join(WORKSPACE_DIR, sessionId);
    await fs.ensureDir(path.join(sessionDir, 'raw'));
    await fs.ensureDir(path.join(sessionDir, 'media'));
    return sessionDir;
  }
  ```
- [ ] Implement `cleanupOldSessions()` to remove sessions older than 24 hours
- [ ] Create `generateSessionId()` using timestamp + random string
- [ ] Add session metadata tracking in `metadata.json`:
  ```typescript
  interface SessionMetadata {
    sessionId: string;
    fileName: string;
    createdAt: string;
    slideCount: number;
  }
  ```

**Acceptance Criteria**:
- Workspace directory structure created on app start:
  ```
  temp_presentation/
  └── <sessionId>/
      ├── raw/           # Unzipped PPTX XML
      ├── media/         # Extracted images
      ├── manifest.json  # Docling output
      └── metadata.json  # Session info
  ```
- Old sessions automatically cleaned up
- Multiple sessions can coexist without conflicts

**Technical Dependencies**: Task 1.2

---

## **PHASE 2: PPTX Ingestion - Dual-Stream Extraction**

### Task 2.1: File Selection with Electron Dialog
**Objective**: Allow user to select PPTX file through native file picker

**Subtasks**:
- [ ] Implement `dialog:openFile` handler in `src/main/ipcHandlers.ts`:
  ```typescript
  import { dialog } from 'electron';
  
  ipcMain.handle('dialog:openFile', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        { name: 'PowerPoint Presentations', extensions: ['pptx'] }
      ]
    });
    
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    
    return result.filePaths[0];
  });
  ```
- [ ] Add file validation:
  - Check file exists
  - Verify `.pptx` extension
  - Check file size (warn if > 100MB)
  - Verify file is readable
- [ ] Create React component `FileSelector.tsx` with:
  - "Select PPTX" button
  - Drag-and-drop zone
  - File metadata display (name, size, last modified)

**Acceptance Criteria**:
- Clicking "Select PPTX" opens native file picker
- Only `.pptx` files are selectable
- Drag-and-drop works for PPTX files
- File metadata displayed after selection

**Technical Dependencies**: Task 1.2, Task 1.3

---

### Task 2.2: Fast Path - Image Extraction with PizZip
**Objective**: Rapidly extract slide images for immediate preview (Fast Path from strategy doc)

**Subtasks**:
- [ ] Install dependencies:
  ```bash
  npm install pizzip @types/pizzip
  ```
- [ ] Create `src/main/services/pptxExtractor.ts`
- [ ] Implement `extractPPTX()`:
  ```typescript
  import PizZip from 'pizzip';
  import fs from 'fs-extra';
  
  export async function extractPPTX(filePath: string, sessionDir: string) {
    // Read PPTX file
    const data = await fs.readFile(filePath);
    const zip = new PizZip(data);
    
    // Extract all files to raw/
    const rawDir = path.join(sessionDir, 'raw');
    for (const fileName in zip.files) {
      const file = zip.files[fileName];
      if (!file.dir) {
        const content = file.asNodeBuffer();
        await fs.outputFile(path.join(rawDir, fileName), content);
      }
    }
    
    // Extract media files
    await extractMediaFiles(zip, sessionDir);
    
    // Parse slide relationships
    const slideManifest = await parseSlideRelationships(rawDir);
    
    return slideManifest;
  }
  ```
- [ ] Implement `extractMediaFiles()` to copy `ppt/media/*` to `media/`
- [ ] Implement `parseSlideRelationships()` to:
  - Parse `ppt/slides/_rels/slide*.xml.rels`
  - Map relationship IDs to media files
  - Return array of `{ slideIndex, imagePaths }`

**Acceptance Criteria**:
- Extraction completes in < 2 seconds for typical deck
- All images from `ppt/media/` copied to `temp_presentation/<sessionId>/media/`
- Slide-to-image mapping correctly generated
- Progress events emitted during extraction

**Technical Dependencies**: Task 2.1

**Performance Target**: < 2s for 50-slide deck with 20 images

---

### Task 2.3: Deep Path - Docling Integration (Background Process)
**Objective**: Run Docling parser in background to extract structural data (Deep Path from strategy doc)

**Subtasks**:
- [ ] Install Docling as Python subprocess dependency
- [ ] Create `src/main/services/doclingParser.ts`
- [ ] Implement `runDoclingParser()`:
  ```typescript
  import { spawn } from 'child_process';
  
  export function runDoclingParser(pptxPath: string, outputPath: string): Promise<DoclingManifest> {
    return new Promise((resolve, reject) => {
      const process = spawn('python', [
        '-m', 'docling',
        '--input', pptxPath,
        '--output', outputPath,
        '--format', 'json'
      ]);
      
      process.on('close', (code) => {
        if (code === 0) {
          const manifest = fs.readJsonSync(outputPath);
          resolve(manifest);
        } else {
          reject(new Error(`Docling failed with code ${code}`));
        }
      });
    });
  }
  ```
- [ ] Define TypeScript interfaces for Docling output:
  ```typescript
  interface DoclingManifest {
    slides: DoclingSlide[];
  }
  
  interface DoclingSlide {
    slideNumber: number;
    elements: DoclingElement[];
    speakerNotes?: string;
  }
  
  interface DoclingElement {
    type: 'text' | 'image' | 'shape';
    bbox: { x: number; y: number; width: number; height: number };
    content: string;
    style?: {
      font: string;
      fontSize: number;
      color: string;
    };
  }
  ```
- [ ] Implement progress tracking for Docling parsing
- [ ] Cache Docling results in `manifest.json`

**Acceptance Criteria**:
- Docling runs asynchronously without blocking UI
- Parsing completes within 10 seconds for typical deck
- Bounding boxes, text content, and speaker notes extracted
- Manifest saved as JSON for later use

**Technical Dependencies**: Task 2.2

**Note**: Docling may take 5-10s, so Fast Path (images) should be usable while Deep Path runs

---

## **PHASE 3: React "Live Mode" - The Presentation Canvas**

### Task 3.1: Base Preview UI - Slide Gallery
**Objective**: Display extracted slides in a scrollable gallery (Pre-Launch validation UI)

**Subtasks**:
- [ ] Create `src/renderer/components/SlideGallery.tsx`
- [ ] Implement thumbnail grid layout:
  ```tsx
  interface SlideGalleryProps {
    slides: SlidePreview[];
    onSlideSelect: (index: number) => void;
  }
  
  function SlideGallery({ slides, onSlideSelect }: SlideGalleryProps) {
    return (
      <div className="gallery-grid">
        {slides.map((slide, index) => (
          <div key={index} className="slide-thumbnail" onClick={() => onSlideSelect(index)}>
            <img src={slide.imagePath} alt={`Slide ${index + 1}`} />
            <span>Slide {index + 1}</span>
          </div>
        ))}
      </div>
    );
  }
  ```
- [ ] Add CSS for responsive grid (3-4 columns)
- [ ] Implement lazy loading for large decks (virtualization)
- [ ] Add "Launch Presentation" button

**Acceptance Criteria**:
- All slides displayed as thumbnails
- Clicking thumbnail shows larger preview
- Smooth scrolling even for 100+ slide decks
- "Launch" button transitions to Live Mode

**Technical Dependencies**: Task 2.2

---

### Task 3.2: Live Mode - Slide Canvas Component
**Objective**: Create the main presentation canvas that renders slides with overlays

**Subtasks**:
- [ ] Create `src/renderer/components/SlideCanvas.tsx`
- [ ] Implement layered rendering architecture:
  ```tsx
  interface SlideCanvasProps {
    currentSlide: number;
    slideData: DoclingSlide;
    slideImage: string;
  }
  
  function SlideCanvas({ currentSlide, slideData, slideImage }: SlideCanvasProps) {
    return (
      <div className="slide-canvas" style={{ aspectRatio: '16 / 9' }}>
        {/* Layer 1: Base image */}
        <img src={slideImage} className="slide-base-image" />
        
        {/* Layer 2: Reactive text overlays */}
        <div className="slide-overlays">
          {slideData.elements.map((element, index) => (
            <TextOverlay key={index} element={element} />
          ))}
        </div>
      </div>
    );
  }
  ```
- [ ] Implement coordinate scaling from PPTX to responsive container:
  ```tsx
  function scaleCoordinates(bbox: BoundingBox, canvasSize: Size): CSSProperties {
    // PPTX uses EMUs (914400 per inch), slide is typically 10" x 7.5"
    const PPTX_WIDTH = 9144000;  // 10 inches in EMUs
    const PPTX_HEIGHT = 6858000; // 7.5 inches in EMUs
    
    return {
      position: 'absolute',
      left: `${(bbox.x / PPTX_WIDTH) * 100}%`,
      top: `${(bbox.y / PPTX_HEIGHT) * 100}%`,
      width: `${(bbox.width / PPTX_WIDTH) * 100}%`,
      height: `${(bbox.height / PPTX_HEIGHT) * 100}%`
    };
  }
  ```
- [ ] Create `TextOverlay.tsx` component for editable text containers
- [ ] Add responsive resizing handler

**Acceptance Criteria**:
- Slide image renders at 16:9 aspect ratio
- Text overlays positioned correctly over image
- Overlays maintain position during window resize
- Canvas fills available screen space

**Technical Dependencies**: Task 2.3, Task 3.1

**Critical**: Coordinate system must handle PPTX EMUs → CSS percentages correctly

---

### Task 3.3: Navigation System - Keyboard & UI Controls
**Objective**: Implement slide navigation and state synchronization

**Subtasks**:
- [ ] Create global state manager using Zustand:
  ```typescript
  import create from 'zustand';
  
  interface PresentationState {
    currentSlide: number;
    totalSlides: number;
    slides: SlideData[];
    goToSlide: (index: number) => void;
    nextSlide: () => void;
    previousSlide: () => void;
  }
  
  export const usePresentationStore = create<PresentationState>((set) => ({
    currentSlide: 0,
    totalSlides: 0,
    slides: [],
    goToSlide: (index) => set({ currentSlide: index }),
    nextSlide: () => set((state) => ({ 
      currentSlide: Math.min(state.currentSlide + 1, state.totalSlides - 1) 
    })),
    previousSlide: () => set((state) => ({ 
      currentSlide: Math.max(state.currentSlide - 1, 0) 
    }))
  }));
  ```
- [ ] Implement keyboard event listeners:
  ```tsx
  useEffect(() => {
    const handleKeyPress = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') nextSlide();
      if (e.key === 'ArrowLeft') previousSlide();
      if (e.key === 'Escape') exitPresentation();
    };
    
    window.addEventListener('keydown', handleKeyPress);
    return () => window.removeEventListener('keydown', handleKeyPress);
  }, []);
  ```
- [ ] Create navigation UI controls (prev/next buttons, slide counter)
- [ ] Add slide thumbnail sidebar (collapsible)

**Acceptance Criteria**:
- Arrow keys navigate between slides
- Navigation UI buttons work
- Current slide number displayed (e.g., "5 / 23")
- State synced across all components (canvas, thumbnails, notes)

**Technical Dependencies**: Task 3.2

---

### Task 3.4: Font Injection & Typography System
**Objective**: Preserve presentation fonts for professional rendering

**Subtasks**:
- [ ] Extract font information from PPTX XML:
  - Parse `ppt/theme/theme1.xml` for font definitions
  - Extract `<a:font>` elements with typeface names
- [ ] Create font fallback system:
  ```typescript
  const FONT_FALLBACKS = {
    'Calibri': ['Calibri', 'Arial', 'sans-serif'],
    'Arial': ['Arial', 'Helvetica', 'sans-serif'],
    'Times New Roman': ['Times New Roman', 'Times', 'serif'],
    // ... add common PowerPoint fonts
  };
  ```
- [ ] Bundle common presentation fonts as Vite assets:
  ```typescript
  // In vite.config.ts
  export default defineConfig({
    assetsInclude: ['**/*.woff', '**/*.woff2', '**/*.ttf']
  });
  ```
- [ ] Implement dynamic font loading:
  ```tsx
  @font-face {
    font-family: 'Calibri';
    src: url('./assets/fonts/calibri.woff2') format('woff2');
  }
  ```
- [ ] Apply fonts to text overlays based on Docling style data

**Acceptance Criteria**:
- Common PowerPoint fonts render correctly
- Fallback fonts used when exact match unavailable
- No font flash or layout shift on load
- Professional typography maintained from original deck

**Technical Dependencies**: Task 3.2

**Note**: This is critical for demo polish - judges will notice if fonts look wrong

---

## **PHASE 4: Critical Polish & Integration**

### Task 4.1: Session Persistence & Recovery
**Objective**: Allow users to resume previous presentation sessions

**Subtasks**:
- [ ] Implement session state serialization:
  ```typescript
  interface SessionState {
    sessionId: string;
    currentSlide: number;
    filePath: string;
    lastAccessed: string;
  }
  ```
- [ ] Save state to `metadata.json` on slide changes
- [ ] Create "Recent Presentations" list in UI
- [ ] Implement "Resume Session" flow
- [ ] Add "Clear Session" button to free disk space

**Acceptance Criteria**:
- Closing and reopening app restores last presentation
- Recent presentations list shows last 5 sessions
- Clicking a recent item reloads that presentation
- Old sessions can be manually deleted

**Technical Dependencies**: Task 1.3, Task 3.3

---

### Task 4.2: Error Handling & Loading States
**Objective**: Gracefully handle extraction failures and provide user feedback

**Subtasks**:
- [ ] Create error boundary components in React
- [ ] Implement loading states:
  ```tsx
  enum ExtractionState {
    IDLE = 'idle',
    EXTRACTING_IMAGES = 'extracting_images',  // Fast Path
    PARSING_STRUCTURE = 'parsing_structure',   // Deep Path
    READY = 'ready',
    ERROR = 'error'
  }
  ```
- [ ] Add progress indicators:
  - Linear progress bar for image extraction
  - Spinner for Docling parsing
  - Success/error toast notifications
- [ ] Handle common failure modes:
  - Corrupted PPTX file
  - Missing media files
  - Docling timeout
  - Insufficient disk space

**Acceptance Criteria**:
- User sees clear feedback during extraction
- Errors display helpful messages (not stack traces)
- Partial success handled (e.g., images load, Docling fails)
- App doesn't crash on malformed PPTX

**Technical Dependencies**: All previous tasks

---

### Task 4.3: Performance Optimization
**Objective**: Ensure smooth performance for large presentations

**Subtasks**:
- [ ] Implement slide image lazy loading:
  ```tsx
  const [loadedSlides, setLoadedSlides] = useState<Set<number>>(new Set());
  
  useEffect(() => {
    // Preload current + next 2 slides
    const slidesToLoad = [currentSlide, currentSlide + 1, currentSlide + 2];
    slidesToLoad.forEach(index => {
      if (!loadedSlides.has(index)) {
        preloadSlideImage(index);
      }
    });
  }, [currentSlide]);
  ```
- [ ] Use React.memo for expensive components
- [ ] Implement virtual scrolling for slide gallery (react-window)
- [ ] Add worker thread for Docling parsing (don't block main process)
- [ ] Optimize image formats (convert PNGs to WebP if large)

**Acceptance Criteria**:
- < 100ms navigation time between slides
- Gallery scrolls smoothly for 100+ slide decks
- Memory usage stays < 500MB for large presentations
- No frame drops during transitions

**Technical Dependencies**: Task 3.1, Task 3.2, Task 3.3

---

## **Success Metrics for MVP**

| Metric | Target | Measurement |
|--------|--------|-------------|
| **Extraction Speed** | < 2s for 50-slide deck | Time from file selection to gallery display |
| **Rendering Accuracy** | 95% layout match to original | Visual comparison with PowerPoint |
| **Navigation Latency** | < 100ms per slide | Time from keypress to render |
| **Font Fidelity** | 90% exact match | Number of correctly rendered fonts |
| **Error Rate** | < 5% for valid PPTX files | Test suite of diverse presentations |

---

## **Development Order (Recommended)**

1. **Week 1**: Tasks 1.1 → 1.3 (Foundation)
2. **Week 2**: Tasks 2.1 → 2.2 (Fast Path extraction + preview)
3. **Week 3**: Task 2.3 + Task 3.1 (Deep Path + gallery UI)
4. **Week 4**: Tasks 3.2 → 3.4 (Live Mode canvas + navigation)
5. **Week 5**: Tasks 4.1 → 4.3 (Polish + optimization)

---

## **Integration with Full NemoStage System**

This PPTX subsystem will eventually integrate with:

- **Live Input Layer**: ASR transcription will trigger slide transitions
- **Presentation State Engine**: Current slide tracked alongside speaker position
- **NemoClaw Agent**: Will inject generated support slides into this canvas
- **Audience Engagement**: QR code overlay rendered on canvas

**Next Phase**: After completing this task list, the team will integrate the WebSocket event bus for real-time slide injection during live presentations.