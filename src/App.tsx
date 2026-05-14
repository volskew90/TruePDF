import React, { useState, useRef, useEffect } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { GoogleGenAI } from '@google/genai';
import { aiConfig } from './config';
import { 
  Upload, FileDown, Printer, FileText, Loader2, StopCircle, 
  CheckCircle, AlertCircle, Edit3, Eye, Trash2, ArrowRight, Play
} from 'lucide-react';
import Markdown from 'react-markdown';

// Initialize PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// Initialize Gemini
const ai = new GoogleGenAI({ apiKey: aiConfig.apiKey });

type PageData = {
  pageNumber: number;
  imageUrl: string;
  extractedText: string;
  status: 'pending' | 'processing' | 'completed' | 'error';
  errorMsg?: string;
  statusMsg?: string;
};

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [totalPages, setTotalPages] = useState<number>(0);
  const [pages, setPages] = useState<PageData[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [pdfDocument, setPdfDocument] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  
  const abortControllerRef = useRef<AbortController | null>(null);
  const [editingPageInfo, setEditingPageInfo] = useState<number | null>(null);

  // Load PDF when file is selected
  useEffect(() => {
    if (!file) return;

    const loadPdf = async () => {
      try {
        const fileUrl = URL.createObjectURL(file);
        const loadingTask = pdfjsLib.getDocument({
          url: fileUrl,
          cMapUrl: `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/cmaps/`,
          cMapPacked: true,
          standardFontDataUrl: `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/standard_fonts/`,
        });
        const pdf = await loadingTask.promise;
        setPdfDocument(pdf);
        setTotalPages(pdf.numPages);
        
        // Initialize pages array
        const initialPages: PageData[] = Array.from({ length: pdf.numPages }, (_, i) => ({
          pageNumber: i + 1,
          imageUrl: '',
          extractedText: '',
          status: 'pending'
        }));
        setPages(initialPages);
      } catch (err) {
        console.error("Error loading PDF:", err);
        alert("Failed to load the PDF. It might be corrupted or not a valid PDF file.");
      }
    };

    loadPdf();
  }, [file]);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (selected && selected.type === 'application/pdf') {
      setFile(selected);
      setPages([]);
      setIsProcessing(false);
      setEditingPageInfo(null);
    } else if (selected) {
      alert("Please upload a valid PDF file.");
    }
  };

  const renderPageToImage = async (pageNum: number): Promise<string> => {
    if (!pdfDocument) throw new Error("PDF not loaded");
    const page = await pdfDocument.getPage(pageNum);
    
    // Calculate a safe scale. We want a max dimension of ~1500px to ensure
    // we don't blow up browser canvas limits, while maintaining high enough
    // resolution for Gemini to read easily.
    let baseViewport = page.getViewport({ scale: 1.0 });
    const maxDim = Math.max(baseViewport.width, baseViewport.height);
    
    // Target ~1500px max dimension
    const scale = 1500 / maxDim;
    const viewport = page.getViewport({ scale });
    
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    
    if (!context) throw new Error("Could not get 2D context");
    
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    
    // Fill with white background (JPEG doesn't support transparency, 
    // transparent areas become black, causing black text on black background)
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    
    try {
      await page.render({ canvasContext: context, viewport } as any).promise;
    } catch(e) {
      console.error("Error rendering PDF page to canvas:", e);
    }
    return canvas.toDataURL('image/jpeg', 0.9);
  };

  const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Aborted'));
    const timeout = setTimeout(() => {
      resolve();
      signal?.removeEventListener('abort', onAbort);
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort);
  });

  // Global rate limiter state
  const lastRequestTimeRef = useRef<number>(0);

  const processPages = async () => {
    if (!pdfDocument || pages.length === 0) return;
    
    setIsProcessing(true);
    abortControllerRef.current = new AbortController();

    const CONCURRENCY_LIMIT = aiConfig.concurrencyLimit; // Process based on config

    try {
      const pendingPages = pages
        .map((p, i) => ({ index: i, page: p }))
        .filter(p => p.page.status !== 'completed' && p.page.status !== 'processing');
      
      let currentIndex = 0;

      const processPage = async (i: number) => {
        if (abortControllerRef.current?.signal.aborted) {
           updatePageStatus(i, { status: 'pending', statusMsg: undefined });
           return;
        }

        updatePageStatus(i, { status: 'processing', statusMsg: 'Extracting...' });

        try {
          // 1. Render page to image
           if (abortControllerRef.current?.signal.aborted) throw new Error('Aborted');
          const dataUrl = await renderPageToImage(i + 1);
          
          if (dataUrl === 'data:,') {
            throw new Error("Failed to render canvas (exceeded memory/size limits)");
          }
          
          const base64Image = dataUrl.split(',')[1];
          updatePageStatus(i, { imageUrl: dataUrl });

          // 2. Call Gemini with exponential backoff and jitter
          let extractedText = '';
          let retryCount = 0;
          const maxRetries = 6; // Increased retries since we might hit 1-min quota
          
          while (retryCount <= maxRetries) {
            try {
              if (abortControllerRef.current?.signal.aborted) throw new Error('Aborted');
              
              // Global throttle to max ~15 requests per minute per free tier (4000ms pause)
              const now = Date.now();
              const timeSinceLast = now - lastRequestTimeRef.current;
              if (timeSinceLast < 4500) {
                updatePageStatus(i, { statusMsg: 'Waiting for rate limit...' });
                await sleep(4500 - timeSinceLast, abortControllerRef.current?.signal);
              }
              lastRequestTimeRef.current = Date.now();
              updatePageStatus(i, { statusMsg: `Calling AI${retryCount > 0 ? ` (Attempt ${retryCount + 1})` : ''}...` });

              const response = await Promise.race([
                ai.models.generateContent({
                  model: aiConfig.model,
                  contents: [
                    {
                      role: 'user',
                      parts: [
                        { text: 'You are an expert OCR and document reconstruction tool. Extract all the text, symbols, and content from this scanned document page exactly as it appears. Preserve paragraph breaks, headers, lists, and general document structure by formatting the output in Markdown. Use appropriate markdown tags (e.g., #, -, *, etc.). Do not add any conversational text, explanations, or commentary. Simply output the extracted text content. If the page is completely 100% blank white paper with absolutely zero content, output "[EMPTY PAGE]".' },
                        { inlineData: { data: base64Image, mimeType: 'image/jpeg' } }
                      ]
                    }
                  ]
                }),
                new Promise<any>((_, reject) => {
                  const timeout = setTimeout(() => reject(new Error('TIMEOUT_ERROR')), 60000);
                  abortControllerRef.current?.signal.addEventListener('abort', () => {
                    clearTimeout(timeout);
                    reject(new Error('Aborted'));
                  });
                })
              ]);

              extractedText = response.text || '';
              break; // Success, exit retry loop
            } catch (apiErr: any) {
              if (apiErr.message === 'Aborted') throw apiErr;
              const errMsg = apiErr.message?.toLowerCase() || '';
              
              if (errMsg.includes('timeout_error')) {
                console.warn(`Timeout on page ${i + 1}. Retrying...`);
                retryCount++;
                continue;
              }
              
              if (errMsg.includes('429') || errMsg.includes('quota') || errMsg.includes('too many requests')) {
                if (retryCount >= maxRetries) {
                   throw new Error("API Quota exceeded. Please resume processing later or upgrade Gemini API plan.");
                }
                retryCount++;
                // Wait longer: 5s, 10s, 20s, 40s to wait out the 1-minute quota reset
                const delayMs = (Math.pow(2, retryCount) * 5000) + (Math.random() * 2000);
                console.warn(`Rate limit hit on page ${i + 1}. Retrying in ${Math.round(delayMs / 1000)}s...`);
                updatePageStatus(i, { statusMsg: `Rate limited. Retrying in ${Math.round(delayMs / 1000)}s...` });
                await sleep(delayMs, abortControllerRef.current?.signal);
              } else {
                throw apiErr;
              }
            }
          }

          if (abortControllerRef.current?.signal.aborted) throw new Error('Aborted');
          
          // 3. Mark completed
          updatePageStatus(i, { 
            extractedText, 
            status: 'completed',
            statusMsg: undefined
          });

        } catch (err) {
          if (err instanceof Error && err.message === 'Aborted') {
             updatePageStatus(i, { status: 'pending', statusMsg: undefined });
             return;
          }
          console.error(`Error processing page ${i + 1}:`, err);
          updatePageStatus(i, { 
            status: 'error', 
            errorMsg: err instanceof Error ? err.message : 'Unknown error',
            statusMsg: undefined
          });
          
          // Stop all processing if we hit hard quota limit that couldn't be recovered
          if (err instanceof Error && err.message.includes('API Quota exceeded')) {
             if (abortControllerRef.current) abortControllerRef.current.abort();
          }
        }
      };

      // Create a pool of workers
      const worker = async () => {
        while (currentIndex < pendingPages.length) {
          if (abortControllerRef.current?.signal.aborted) break;
          const task = pendingPages[currentIndex++];
          await processPage(task.index);
        }
      };

      // Start workers
      const workers = Array.from({ length: CONCURRENCY_LIMIT }, () => worker());
      await Promise.all(workers);

    } finally {
      setIsProcessing(false);
    }
  };

  const stopProcessing = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    setIsProcessing(false);
  };

  const updatePageStatus = (index: number, updates: Partial<PageData>) => {
    setPages(prev => {
      const newPages = [...prev];
      newPages[index] = { ...newPages[index], ...updates };
      return newPages;
    });
  };

  const handleTextChange = (index: number, newText: string) => {
    updatePageStatus(index, { extractedText: newText });
  };

  const getCombinedMarkdown = () => {
    return pages
      .filter(p => p.status === 'completed' && p.extractedText.trim() !== '[EMPTY PAGE]')
      .map(p => p.extractedText)
      .join('\n\n---\n\n');
  };

  const downloadFile = (filename: string, content: string, type: string) => {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const downloadMarkdown = () => {
    downloadFile((file?.name.replace('.pdf', '') || 'scanned-book') + '.md', getCombinedMarkdown(), 'text/markdown;charset=utf-8');
  };

  const printToPdf = () => {
    window.print();
  };

  // Stats
  const completedCount = pages.filter(p => p.status === 'completed').length;
  const errorCount = pages.filter(p => p.status === 'error').length;
  const progressPercent = totalPages === 0 ? 0 : Math.round((completedCount / totalPages) * 100);

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#e0e0e0] flex flex-col font-sans">
      {/* HEADER structure */}
      <header className="h-16 border-b border-white/10 px-6 bg-[#0d0d0d] flex items-center justify-between sticky top-0 z-10 print-hide">
        <div className="flex items-center space-x-3">
          <div className="w-8 h-8 bg-emerald-500 rounded flex items-center justify-center text-black font-bold">
            <FileText className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-sm font-semibold tracking-widest uppercase text-white">PDF OCR Digitizer</h1>
            <p className="text-[10px] text-white/40 uppercase tracking-tighter">Convert scanned image PDFs into searchable digital books.</p>
          </div>
        </div>
        
        {pages.length > 0 && (
          <div className="flex items-center space-x-3">
            <button
              onClick={downloadMarkdown}
              disabled={completedCount === 0}
              className="flex items-center space-x-2 px-4 py-2 bg-transparent border border-white/20 hover:bg-white/5 text-white/80 text-xs font-bold rounded transition-colors uppercase tracking-widest disabled:opacity-50"
            >
              <FileDown className="w-4 h-4" />
              <span>Export .md</span>
            </button>
            <button
              onClick={printToPdf}
              disabled={completedCount === 0}
              className="flex items-center space-x-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded transition-colors uppercase tracking-widest disabled:opacity-50"
            >
              <Printer className="w-4 h-4" />
              <span>Print to PDF</span>
            </button>
          </div>
        )}
      </header>

      <main className="flex-1 w-full max-w-7xl mx-auto p-6 md:p-8">
        
        {/* PRINT ONLY CONTENT */}
        <div className="hidden print-block w-full text-black max-w-4xl mx-auto bg-white">
           <div className="markdown-body prose prose-slate max-w-none">
             <Markdown>{getCombinedMarkdown()}</Markdown>
           </div>
        </div>

        <div className="print-hide space-y-6">
          {!file ? (
            <div className="w-full flex justify-center items-center h-[60vh]">
              <label className="flex flex-col items-center justify-center w-full max-w-2xl h-80 border border-dashed border-white/20 rounded cursor-pointer bg-[#121212] hover:bg-[#151515] transition-colors shadow-sm group">
                <div className="flex flex-col items-center justify-center pt-5 pb-6">
                  <div className="p-4 bg-emerald-500/10 rounded group-hover:bg-emerald-500/20 transition-colors mb-4 text-emerald-500">
                    <Upload className="w-8 h-8" />
                  </div>
                  <p className="mb-2 text-sm uppercase tracking-widest font-semibold text-white">Upload scanned PDF</p>
                  <p className="text-xs text-white/40 max-w-sm text-center">Drag and drop or click to upload. We'll extract text from all image pages to recreate the book.</p>
                </div>
                <input id="dropzone-file" type="file" className="hidden" accept="application/pdf" onChange={handleFileUpload} />
              </label>
            </div>
          ) : (
            <div className="grid grid-cols-1 xl:grid-cols-12 gap-8">
              {/* LEFT COLUMN: Controls & Status */}
              <div className="xl:col-span-4 space-y-6">
                <div className="bg-[#121212] p-6 rounded shadow-lg border border-white/10 glass-panel">
                  <div className="flex justify-between items-start mb-6">
                    <div>
                      <h2 className="text-sm font-semibold tracking-widest uppercase text-white truncate max-w-[200px]" title={file.name}>{file.name}</h2>
                      <p className="text-[10px] text-white/40 uppercase tracking-tighter">{totalPages} pages total</p>
                    </div>
                    <button onClick={() => setFile(null)} className="text-white/40 hover:text-red-400 transition-colors p-1" title="Clear file">
                      <Trash2 className="w-5 h-5" />
                    </button>
                  </div>

                  {/* Progress Bar */}
                  <div className="mb-6">
                    <div className="flex justify-between text-[10px] uppercase tracking-widest mb-2 font-medium">
                      <span className="text-white/60">Extraction Progress</span>
                      <span className="text-emerald-400">{progressPercent}%</span>
                    </div>
                    <div className="w-full bg-white/10 rounded h-1.5 overflow-hidden">
                      <div 
                        className="bg-emerald-500 h-1.5 rounded transition-all duration-500 ease-out" 
                        style={{ width: `${progressPercent}%` }}
                      ></div>
                    </div>
                    <div className="flex gap-4 mt-3 text-xs text-white/60">
                      <div className="flex items-center gap-1"><CheckCircle className="w-3 h-3 text-emerald-500"/> {completedCount} done</div>
                      <div className="flex items-center gap-1"><AlertCircle className="w-3 h-3 text-red-500"/> {errorCount} errors</div>
                    </div>
                  </div>

                  {/* Controls */}
                  <div className="flex gap-3">
                    {isProcessing ? (
                      <button 
                        onClick={stopProcessing}
                        className="flex-1 flex justify-center items-center space-x-2 bg-red-500/10 hover:bg-red-500/20 text-red-400 border-red-500/20 font-bold uppercase tracking-widest text-xs py-2.5 rounded transition-colors"
                      >
                        <StopCircle className="w-4 h-4" />
                        <span>Stop OCR</span>
                      </button>
                    ) : (
                      <button 
                        onClick={processPages}
                        disabled={completedCount === totalPages}
                        className="flex-1 flex justify-center items-center space-x-2 bg-emerald-600 hover:bg-emerald-500 text-white font-bold uppercase tracking-widest text-xs py-2.5 rounded transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <Play className="w-4 h-4" fill="currentColor" />
                        <span>{completedCount > 0 ? 'Resume OCR' : 'Start OCR Extraction'}</span>
                      </button>
                    )}
                  </div>
                </div>

                {/* Info Card */}
                <div className="p-5 rounded border border-white/10 glass-panel bg-[#151515]">
                  <h3 className="font-medium text-white/60 text-[10px] uppercase tracking-widest mb-2 flex items-center gap-2">
                    <div className="w-1.5 h-1.5 rounded-full bg-emerald-500"></div>
                    How this works
                  </h3>
                  <p className="text-xs text-white/40 leading-relaxed">
                    This tool renders each PDF page into an image locally, then uses Google's Gemini Vision model to read and reconstruct the text perfectly preserving paragraphs and markdown structure. Edit results dynamically to correct any AI errors before generating your final true PDF.
                  </p>
                </div>
              </div>

              {/* RIGHT COLUMN: Pages List */}
              <div className="xl:col-span-8 flex flex-col space-y-4">
                <div className="flex items-center justify-between px-1">
                   <h2 className="text-[11px] font-medium text-white/60 uppercase tracking-widest">Extracted Pages</h2>
                   <span className="text-[10px] font-medium bg-white/10 text-white/60 px-2 py-0.5 rounded border border-white/5 uppercase tracking-widest">
                     {completedCount} / {totalPages}
                   </span>
                </div>

                <div className="space-y-4">
                  {pages.map((page, index) => (
                    <div key={index} className="bg-[#0f0f0f] rounded shadow-lg border border-white/5 overflow-hidden transition-all">
                      {/* Page Header */}
                      <div className="p-4 flex items-center justify-between bg-[#151515] border-b border-white/5">
                        <div className="flex items-center space-x-3">
                          <span className="font-mono text-xs font-semibold text-white/40 bg-white/5 border border-white/10 px-2 py-0.5 rounded uppercase">PG {page.pageNumber}</span>
                          
                          {/* Status Badge */}
                          {page.status === 'pending' && <span className="text-[10px] font-medium text-white/40 bg-white/5 px-2 py-0.5 rounded uppercase tracking-wider">Pending</span>}
                          {page.status === 'processing' && (
                            <span className="flex items-center gap-1.5 text-[10px] font-medium text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded uppercase tracking-wider">
                              <Loader2 className="w-3 h-3 animate-spin"/> {page.statusMsg || 'Extracting...'}
                            </span>
                          )}
                          {page.status === 'completed' && <span className="flex items-center gap-1.5 text-[10px] font-medium text-emerald-400 bg-emerald-500/20 px-2 py-0.5 rounded uppercase tracking-wider"><CheckCircle className="w-3 h-3"/> Done</span>}
                          {page.status === 'error' && <span className="flex items-center gap-1.5 text-[10px] font-medium text-red-400 bg-red-500/10 px-2 py-0.5 rounded uppercase tracking-wider" title={page.errorMsg}><AlertCircle className="w-3 h-3"/> Error</span>}
                        </div>

                        {page.status === 'completed' && (
                          <button
                            onClick={() => setEditingPageInfo(editingPageInfo === index ? null : index)}
                            className="flex items-center space-x-1 text-[10px] font-bold text-white/40 hover:text-emerald-400 uppercase tracking-widest transition-colors"
                          >
                            {editingPageInfo === index ? (
                              <><Eye className="w-4 h-4"/> <span>Preview</span></>
                            ) : (
                              <><Edit3 className="w-4 h-4"/> <span>Edit Text</span></>
                            )}
                          </button>
                        )}
                      </div>

                      {/* Content Area */}
                      {page.status === 'completed' && (
                        <div className="p-0 bg-[#0f0f0f]">
                          {editingPageInfo === index ? (
                            <div className="flex flex-col md:flex-row divide-y md:divide-y-0 md:divide-x divide-white/10">
                               {/* Image Thumbnail (Left) */}
                               <div className="w-full md:w-1/3 bg-[#121212] p-4 flex items-start justify-center technical-grid">
                                 {page.imageUrl ? (
                                   <img src={page.imageUrl} alt={`Page ${page.pageNumber}`} className="max-w-full shadow-md rounded border border-white/10 object-contain" />
                                 ) : (
                                   <div className="text-xs text-white/40">No Image Available</div>
                                 )}
                               </div>
                               {/* Text Editor (Right) */}
                               <div className="w-full md:w-2/3 bg-[#0a0a0a]">
                                 <textarea
                                   value={page.extractedText}
                                   onChange={(e) => handleTextChange(index, e.target.value)}
                                   className="w-full h-full min-h-[300px] bg-transparent p-4 text-sm font-mono text-[#e0e0e0] resize-y focus:outline-none focus:ring-inset focus:ring-1 focus:ring-emerald-500 border-none block"
                                   placeholder="Extracted text will appear here..."
                                   spellCheck={false}
                                 />
                               </div>
                            </div>
                          ) : (
                            <div className="p-6 max-w-none bg-transparent">
                               {page.extractedText.trim() === '' ? (
                                  <p className="text-white/30 italic font-serif">No text extracted.</p>
                               ) : page.extractedText.includes('[EMPTY PAGE]') ? (
                                  <div className="flex justify-center py-6 text-white/30 font-medium tracking-widest text-[10px] uppercase border border-dashed border-white/10 rounded">Empty Page</div>
                               ) : (
                                  <div className="markdown-body">
                                    <Markdown>{page.extractedText}</Markdown>
                                  </div>
                               )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

