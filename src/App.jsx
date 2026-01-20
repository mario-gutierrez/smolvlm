import { useEffect, useState, useRef, useCallback } from "react";
import Progress from "./components/Progress";

const IS_WEBGPU_AVAILABLE = !!navigator.gpu;

function App() {
  // Create a reference to the worker object.
  const worker = useRef(null);

  // Model loading and progress
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [loadingMessage, setLoadingMessage] = useState("");
  const [progressItems, setProgressItems] = useState([]);
  
  // App Logic State
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  
  // Refs for auto-scrolling output
  const outputRefs = useRef({});

  // Input Source State
  const [inputSource, setInputSource] = useState("camera");
  const [cameras, setCameras] = useState([]);
  const [selectedCamera, setSelectedCamera] = useState("");
  const [videoFileUrl, setVideoFileUrl] = useState(null);

  // Analysis State
  const [videoFramerate, setVideoFramerate] = useState(0); 
  const [isAnalysisRunning, setIsAnalysisRunning] = useState(false);
  
  // --- Multi-Prompt State ---
  const [prompts, setPrompts] = useState([
    { id: 0, text: "What is the person doing?", enabled: true },
    { id: 1, text: "", enabled: true }
  ]);
  const [outputs, setOutputs] = useState({ 0: "", 1: "" });
  const [tps, setTps] = useState(null);
  
  // Queue system for sequential processing
  const isWorkerBusy = useRef(false);
  const pendingRequests = useRef([]); 
  const inferenceInterval = useRef(null);

  // --- Auto-Scroll Logic ---
  useEffect(() => {
    // Iterate over all registered output refs and scroll them to the bottom
    Object.values(outputRefs.current).forEach((el) => {
      if (el) {
        el.scrollTop = el.scrollHeight;
      }
    });
  }, [outputs]); // Triggers whenever new tokens are added

  // --- Worker Initialization ---
  useEffect(() => {
    if (!worker.current) {
      worker.current = new Worker(new URL("./worker.js", import.meta.url), {
        type: "module",
      });
      worker.current.postMessage({ type: "check" });
    }

    const onMessageReceived = (e) => {
      const { status, id, output, tps: newTps, data } = e.data;

      switch (status) {
        case "loading":
          setStatus("loading");
          setLoadingMessage(data);
          break;

        case "initiate":
          setProgressItems((prev) => [...prev, e.data]);
          break;

        case "progress":
          setProgressItems((prev) =>
            prev.map((item) => {
              if (item.file === e.data.file) {
                return { ...item, ...e.data };
              }
              return item;
            }),
          );
          break;

        case "done":
          setProgressItems((prev) =>
            prev.filter((item) => item.file !== e.data.file),
          );
          break;

        case "ready":
          setStatus("ready");
          break;

        case "start":
            setOutputs((prev) => ({
                ...prev,
                [id]: prev[id] ? prev[id] + "\n\n---------------\n" : ""
            }));
            break;

        case "update":
          setTps(newTps);
          setOutputs((prev) => ({
            ...prev,
            [id]: prev[id] + output
          }));
          break;

        case "complete":
          processRequestQueue();
          break;

        case "error":
          setError(data);
          isWorkerBusy.current = false;
          setIsAnalysisRunning(false);
          pendingRequests.current = [];
          break;
      }
    };

    const onErrorReceived = (e) => {
      console.error("Worker error:", e);
      isWorkerBusy.current = false;
    };

    worker.current.addEventListener("message", onMessageReceived);
    worker.current.addEventListener("error", onErrorReceived);

    return () => {
      worker.current.removeEventListener("message", onMessageReceived);
      worker.current.removeEventListener("error", onErrorReceived);
    };
  }, []);

  // --- Queue Processor ---
  const processRequestQueue = useCallback(() => {
    if (pendingRequests.current.length === 0) {
        isWorkerBusy.current = false;
        if (videoFramerate === -1 && isAnalysisRunning) {
            triggerInference();
        }
        return;
    }

    isWorkerBusy.current = true;
    const nextRequest = pendingRequests.current.shift();
    
    worker.current.postMessage({ 
        type: "generate", 
        data: nextRequest.message,
        id: nextRequest.id 
    });

  }, [videoFramerate, isAnalysisRunning]);

  // --- Video Source Logic ---
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
      if (videoFileUrl) {
        URL.revokeObjectURL(videoFileUrl);
      }
    };
  }, []);

  useEffect(() => {
    if (status !== 'ready' || inputSource !== 'camera') {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
        streamRef.current = null;
      }
      return;
    }

    const setupCamera = async () => {
      try {
        const constraints = selectedCamera 
          ? { video: { deviceId: { exact: selectedCamera } } } 
          : { video: true };

        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        streamRef.current = stream;

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.src = "";
        }

        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(d => d.kind === 'videoinput');
        setCameras(videoDevices);

        if (!selectedCamera && videoDevices.length > 0) {
           const videoTracks = stream.getVideoTracks();
           if (videoTracks.length > 0) {
              const activeDeviceId = videoTracks[0].getSettings().deviceId;
              if (activeDeviceId) setSelectedCamera(activeDeviceId);
              else setSelectedCamera(videoDevices[0].deviceId);
           }
        }
      } catch (err) {
        console.error("Error accessing webcam:", err);
        setError("Could not access webcam. Please ensure permissions are granted.");
      }
    };
    setupCamera();
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
        streamRef.current = null;
      }
    };
  }, [status, inputSource, selectedCamera]);

  useEffect(() => {
    if (inputSource === 'file' && videoFileUrl && videoRef.current) {
      videoRef.current.srcObject = null;
      videoRef.current.src = videoFileUrl;
      videoRef.current.play().catch(e => console.log("Auto-play prevented", e));
    }
  }, [inputSource, videoFileUrl]);

  const handleFileUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (videoFileUrl) URL.revokeObjectURL(videoFileUrl);
    const url = URL.createObjectURL(file);
    setVideoFileUrl(url);
    setIsAnalysisRunning(false);
  };

  // --- Inference Logic ---
  const captureFrame = useCallback(() => {
    if (!videoRef.current || !canvasRef.current) return null;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (video.readyState < 2) return null;

    const context = canvas.getContext('2d');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.8);
  }, []);

  const triggerInference = useCallback(() => {
    if (isWorkerBusy.current) return;
    
    const image = captureFrame();
    if (!image) return;

    const requests = prompts
        .filter(p => p.enabled && p.text.trim().length > 0)
        .map(p => ({
            id: p.id,
            message: [{ 
                role: "user", 
                content: [
                    { type: "image", image: image },
                    { type: "text", text: p.text }
                ]
            }]
        }));

    if (requests.length === 0) return;

    pendingRequests.current = requests;
    processRequestQueue();
    
  }, [prompts, captureFrame, processRequestQueue]);

  useEffect(() => {
    if (!isAnalysisRunning || status !== 'ready') {
      if (inferenceInterval.current) clearInterval(inferenceInterval.current);
      return;
    }

    if (videoFramerate > 0) {
      const intervalMs = 1000 / videoFramerate;
      inferenceInterval.current = setInterval(triggerInference, intervalMs);
    } else if (videoFramerate === -1) {
       triggerInference();
    }

    return () => {
      if (inferenceInterval.current) clearInterval(inferenceInterval.current);
    };
  }, [isAnalysisRunning, videoFramerate, status, triggerInference]);

  const toggleAnalysis = () => {
    if (isAnalysisRunning) {
      setIsAnalysisRunning(false);
      worker.current.postMessage({ type: "interrupt" });
      pendingRequests.current = [];
    } else {
      setIsAnalysisRunning(true);
      if (inputSource === 'file' && videoRef.current) {
        videoRef.current.play();
      }
    }
  };

  const updatePrompt = (id, newText) => {
    setPrompts(prev => prev.map(p => p.id === id ? { ...p, text: newText } : p));
  };

  const clearOutput = (id) => {
    setOutputs(prev => ({ ...prev, [id]: "" }));
  };

  return IS_WEBGPU_AVAILABLE ? (
    <div className="flex flex-col h-screen mx-auto text-gray-800 dark:text-gray-200 bg-white dark:bg-gray-900">
      
      {/* Header */}
      <div className="flex flex-col items-center pt-4 pb-2 px-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 shrink-0">
         <div className="flex items-center gap-4 mb-2">
            <div className="flex items-center gap-2">
               <img src="logo.png" className="w-8 h-8"/>
               <h1 className="text-xl font-bold">SmolVLM Video Analysis</h1>
            </div>
         </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 overflow-hidden relative flex flex-col">
      
      {status === null && (
        <div className="h-full overflow-auto scrollbar-thin flex justify-center items-center flex-col relative p-4">
            <h2 className="text-2xl font-semibold text-center mb-4">
              Real-time Video Analysis
            </h2>
            <p className="max-w-[500px] mb-6 text-center text-gray-600 dark:text-gray-400">
              Load <span className="font-semibold">SmolVLM2-500M-Video-Instruct</span> to analyze your camera feed or video files entirely in the browser using WebGPU.
            </p>
            {error && (
              <div className="text-red-500 text-center mb-4 p-2 bg-red-50 dark:bg-red-900/20 rounded">
                <p>Error: {error}</p>
              </div>
            )}
            <button
              className="px-6 py-3 rounded-xl bg-blue-500 text-white font-semibold hover:bg-blue-600 transition-colors shadow-lg shadow-blue-500/30"
              onClick={() => {
                worker.current.postMessage({ type: "load" });
                setStatus("loading");
              }}
            >
              Load Model
            </button>
        </div>
      )}

      {status === "loading" && (
        <div className="flex-1 flex flex-col justify-center items-center p-8">
            <p className="text-lg mb-4 font-medium animate-pulse">{loadingMessage}</p>
            <div className="w-full max-w-md space-y-2">
            {progressItems.map(({ file, progress, total }, i) => (
              <Progress key={i} text={file} percentage={progress} total={total} />
            ))}
            </div>
        </div>
      )}

      {status === "ready" && (
        <div className="flex-1 flex flex-col p-4 gap-4 h-full overflow-hidden max-w-7xl mx-auto w-full">
            {/* Control Panel */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 bg-gray-100 dark:bg-gray-800 p-4 rounded-xl shrink-0">
               
               {/* 1. Source */}
               <div className="flex flex-col gap-1">
                  <label className="text-xs font-semibold uppercase text-gray-500">Input Source</label>
                  <select 
                     className="p-2 rounded bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 text-sm"
                     value={inputSource}
                     onChange={(e) => { setInputSource(e.target.value); setIsAnalysisRunning(false); }}
                  >
                     <option value="camera">Webcam</option>
                     <option value="file">Upload Video File</option>
                  </select>
               </div>

               {/* 2. Device/File */}
               <div className="flex flex-col gap-1">
                  <label className="text-xs font-semibold uppercase text-gray-500">
                    {inputSource === 'camera' ? 'Select Camera' : 'Select Video File'}
                  </label>
                  {inputSource === 'camera' ? (
                     <select 
                        className="p-2 rounded bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 text-sm"
                        value={selectedCamera}
                        onChange={(e) => setSelectedCamera(e.target.value)}
                     >
                        {cameras.length === 0 && <option>Loading cameras...</option>}
                        {cameras.map(cam => (
                           <option key={cam.deviceId} value={cam.deviceId}>{cam.label || `Cam ${cam.deviceId.slice(0,4)}`}</option>
                        ))}
                     </select>
                  ) : (
                     <input 
                       type="file" 
                       accept="video/*"
                       className="p-1.5 rounded bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 text-sm"
                       onChange={handleFileUpload}
                     />
                  )}
               </div>
               
               {/* 3. Framerate */}
               <div className="flex flex-col gap-1">
                  <label className="text-xs font-semibold uppercase text-gray-500">Framerate</label>
                  <select 
                     className="p-2 rounded bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 text-sm"
                     value={videoFramerate}
                     onChange={(e) => setVideoFramerate(Number(e.target.value))}
                  >
                     <option value={0}>Manual Trigger</option>
                     <option value={0.2}>Every 5s</option>
                     <option value={0.5}>Every 2s</option>
                     <option value={1}>Every 1s</option>
                     <option value={-1}>Max Speed</option>
                  </select>
               </div>

               {/* 4. Main Action */}
               <div className="flex flex-col gap-1 justify-end">
                  <button
                    onClick={videoFramerate === 0 ? triggerInference : toggleAnalysis}
                    className={`w-full px-4 py-2 rounded font-medium text-white transition-colors shadow-md ${
                        videoFramerate === 0 
                            ? (isWorkerBusy.current ? 'bg-gray-400 cursor-not-allowed' : 'bg-blue-500 hover:bg-blue-600')
                            : (isAnalysisRunning ? 'bg-red-500 hover:bg-red-600' : 'bg-green-500 hover:bg-green-600')
                    }`}
                    disabled={(videoFramerate === 0 && isWorkerBusy.current) || (inputSource === 'file' && !videoFileUrl)}
                  >
                    {videoFramerate === 0 
                        ? (isWorkerBusy.current ? 'Analyzing...' : 'Analyze Frame') 
                        : (isAnalysisRunning ? 'Stop Loop' : 'Start Loop')}
                  </button>
               </div>
            </div>

            {/* Split View */}
            <div className="flex-1 flex flex-col lg:flex-row gap-4 min-h-0">
               
               {/* Video Feed */}
               <div className="lg:w-1/2 bg-black rounded-xl overflow-hidden relative flex items-center justify-center border border-gray-800">
                  <video 
                     ref={videoRef} 
                     autoPlay 
                     playsInline 
                     loop={inputSource === 'file'}
                     muted 
                     controls={inputSource === 'file'}
                     className="max-w-full max-h-full object-contain"
                  ></video>
                  <canvas ref={canvasRef} className="hidden"></canvas>
                  <div className="absolute top-2 right-2 bg-black/60 text-white text-xs px-2 py-1 rounded backdrop-blur-sm z-10 pointer-events-none">
                     {isAnalysisRunning ? '● Analyzing' : '○ Standby'} {tps ? `| ${tps.toFixed(1)} t/s` : ''}
                  </div>
               </div>

               {/* Output Panel */}
               <div className="lg:w-1/2 flex flex-col gap-2">
                  {prompts.map((prompt) => (
                    <div key={prompt.id} className="flex-1 flex flex-col bg-gray-50 dark:bg-gray-800 rounded-xl p-3 border border-gray-200 dark:border-gray-700 overflow-hidden">
                       
                       {/* Input Area */}
                       <div className="flex gap-2 mb-2">
                          <input 
                            type="text"
                            placeholder={`Prompt ${prompt.id + 1}`}
                            className="flex-1 p-2 rounded bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 text-sm"
                            value={prompt.text}
                            onChange={(e) => updatePrompt(prompt.id, e.target.value)}
                          />
                          <button 
                            className="px-3 py-1 text-xs bg-gray-200 dark:bg-gray-600 hover:bg-gray-300 dark:hover:bg-gray-500 rounded text-gray-700 dark:text-gray-200 transition-colors"
                            onClick={() => clearOutput(prompt.id)}
                          >
                            Clear
                          </button>
                       </div>

                       {/* Output Area with Auto-Scroll Ref */}
                       <div 
                         ref={(el) => (outputRefs.current[prompt.id] = el)}
                         className="flex-1 overflow-y-auto whitespace-pre-wrap font-mono text-sm leading-relaxed text-gray-800 dark:text-gray-300 p-2 bg-white dark:bg-gray-900 rounded border border-gray-200 dark:border-gray-700 shadow-inner"
                       >
                          {outputs[prompt.id] 
                            ? outputs[prompt.id] 
                            : <span className="text-gray-400 italic text-xs">Waiting for generation...</span>
                          }
                       </div>
                    </div>
                  ))}
               </div>
            </div>
        </div>
      )}

      </div>
      <p className="text-xs text-gray-400 text-center py-2 bg-white dark:bg-gray-900 border-t border-gray-100 dark:border-gray-800">
        Disclaimer: Generated content may be inaccurate. WebGPU usage can be intensive.
      </p>
    </div>
  ) : (
    <div className="fixed w-screen h-screen bg-black z-10 bg-opacity-[92%] text-white text-2xl font-semibold flex justify-center items-center text-center">
      WebGPU is not supported by this browser :(
    </div>
  );
}

export default App;