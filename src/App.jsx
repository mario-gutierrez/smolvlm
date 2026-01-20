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
  const streamRef = useRef(null); // Keep track of the camera stream to stop it when switching modes

  // Input Source State
  const [inputSource, setInputSource] = useState("camera"); // 'camera' or 'file'
  const [cameras, setCameras] = useState([]);
  const [selectedCamera, setSelectedCamera] = useState("");
  const [videoFileUrl, setVideoFileUrl] = useState(null);

  // Analysis State
  const [videoFramerate, setVideoFramerate] = useState(0); // 0 = manual/stopped
  const [videoPrompt, setVideoPrompt] = useState("Describe this image");
  const [isAnalysisRunning, setIsAnalysisRunning] = useState(false);
  const [modelOutput, setModelOutput] = useState("");
  const [tps, setTps] = useState(null);
  
  const isWorkerBusy = useRef(false);
  const inferenceInterval = useRef(null);

  // --- Worker Initialization ---
  useEffect(() => {
    if (!worker.current) {
      worker.current = new Worker(new URL("./worker.js", import.meta.url), {
        type: "module",
      });
      worker.current.postMessage({ type: "check" });
    }

    const onMessageReceived = (e) => {
      switch (e.data.status) {
        case "loading":
          setStatus("loading");
          setLoadingMessage(e.data.data);
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
          setModelOutput("");
          break;

        case "update":
          const { output, tps } = e.data;
          setTps(tps);
          setModelOutput((prev) => prev + output);
          break;

        case "complete":
          isWorkerBusy.current = false;
          // If continuous "Max Speed" mode, trigger next frame immediately
          if (videoFramerate === -1 && isAnalysisRunning) {
              triggerInference();
          }
          break;

        case "error":
          setError(e.data.data);
          isWorkerBusy.current = false;
          setIsAnalysisRunning(false);
          break;
      }
    };

    const onErrorReceived = (e) => {
      console.error("Worker error:", e);
    };

    worker.current.addEventListener("message", onMessageReceived);
    worker.current.addEventListener("error", onErrorReceived);

    return () => {
      worker.current.removeEventListener("message", onMessageReceived);
      worker.current.removeEventListener("error", onErrorReceived);
    };
  }, [videoFramerate, isAnalysisRunning]);

  // --- Video Source Logic ---

  // Cleanup effect when unmounting or switching sources
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

  // Handle Camera Setup
  useEffect(() => {
    if (status !== 'ready' || inputSource !== 'camera') {
      // Stop camera if we switch away
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
          videoRef.current.src = ""; // Clear src if it was set by file
        }

        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(d => d.kind === 'videoinput');
        setCameras(videoDevices);

        if (!selectedCamera && videoDevices.length > 0) {
           const videoTracks = stream.getVideoTracks();
           if (videoTracks.length > 0) {
              const activeDeviceId = videoTracks[0].getSettings().deviceId;
              if (activeDeviceId) {
                  setSelectedCamera(activeDeviceId);
              } else {
                  setSelectedCamera(videoDevices[0].deviceId);
              }
           }
        }
      } catch (err) {
        console.error("Error accessing webcam:", err);
        setError("Could not access webcam. Please ensure permissions are granted.");
      }
    };

    setupCamera();

    return () => {
      // Cleanup happens on re-run or unmount
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
        streamRef.current = null;
      }
    };
  }, [status, inputSource, selectedCamera]);

  // Handle Video File Setup
  useEffect(() => {
    if (inputSource === 'file' && videoFileUrl && videoRef.current) {
      videoRef.current.srcObject = null; // Clear camera stream
      videoRef.current.src = videoFileUrl;
      videoRef.current.play().catch(e => console.log("Auto-play prevented", e));
    }
  }, [inputSource, videoFileUrl]);

  const handleFileUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    // Cleanup old url
    if (videoFileUrl) URL.revokeObjectURL(videoFileUrl);

    const url = URL.createObjectURL(file);
    setVideoFileUrl(url);
    setIsAnalysisRunning(false); // Stop any running analysis
  };

  // --- Inference Logic ---

  const captureFrame = useCallback(() => {
    if (!videoRef.current || !canvasRef.current) return null;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    
    if (video.readyState < 2) return null; // 2 = HAVE_CURRENT_DATA

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

    isWorkerBusy.current = true;
    
    const message = [
      { role: "user", content: [
        { type: "image", image: image },
        { type: "text", text: videoPrompt }
      ]}
    ];
    
    worker.current.postMessage({ type: "generate", data: message });
  }, [videoPrompt, captureFrame]);

  // Handle Loop Interval
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
    } else {
      setIsAnalysisRunning(true);
      // If using a video file, ensure it's playing
      if (inputSource === 'file' && videoRef.current) {
        videoRef.current.play();
      }
    }
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
              Load <span className="font-semibold">SmolVLM-256M-Instruct</span> to analyze your camera feed or video files entirely in the browser using WebGPU.
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
        <div className="flex-1 flex flex-col p-4 gap-4 h-full overflow-hidden max-w-6xl mx-auto w-full">
            {/* Control Panel */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 bg-gray-100 dark:bg-gray-800 p-4 rounded-xl">
               
               {/* 1. Input Source Selection */}
               <div className="flex flex-col gap-1">
                  <label className="text-xs font-semibold uppercase text-gray-500">Input Source</label>
                  <select 
                     className="p-2 rounded bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 text-sm"
                     value={inputSource}
                     onChange={(e) => {
                        setInputSource(e.target.value);
                        setIsAnalysisRunning(false);
                     }}
                  >
                     <option value="camera">Webcam</option>
                     <option value="file">Upload Video File</option>
                  </select>
               </div>

               {/* 2. Source Options (Camera Select or File Upload) */}
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
                           <option key={cam.deviceId} value={cam.deviceId}>{cam.label || `Camera ${cam.deviceId.slice(0,5)}...`}</option>
                        ))}
                     </select>
                  ) : (
                     <input 
                       type="file" 
                       accept="video/*"
                       className="p-1.5 rounded bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 text-sm file:mr-2 file:py-0.5 file:px-2 file:rounded file:border-0 file:text-xs file:bg-blue-500 file:text-white hover:file:bg-blue-600"
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
                     <option value={0.2}>0.2 FPS (Every 5s)</option>
                     <option value={0.5}>0.5 FPS (Every 2s)</option>
                     <option value={1}>1.0 FPS (Every 1s)</option>
                     <option value={-1}>Max Speed (Continuous)</option>
                  </select>
               </div>

               {/* 4. Prompt & Actions */}
               <div className="flex flex-col gap-1 lg:col-span-1">
                  <label className="text-xs font-semibold uppercase text-gray-500">Prompt</label>
                  <div className="flex gap-2">
                     <input 
                       type="text" 
                       className="flex-1 p-2 rounded bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 text-sm min-w-0"
                       value={videoPrompt}
                       onChange={(e) => setVideoPrompt(e.target.value)}
                     />
                     <button
                        onClick={videoFramerate === 0 ? triggerInference : toggleAnalysis}
                        className={`px-4 py-2 rounded font-medium text-white transition-colors shrink-0 ${
                           videoFramerate === 0 
                             ? (isWorkerBusy.current ? 'bg-gray-400 cursor-not-allowed' : 'bg-blue-500 hover:bg-blue-600')
                             : (isAnalysisRunning ? 'bg-red-500 hover:bg-red-600' : 'bg-green-500 hover:bg-green-600')
                        }`}
                        disabled={(videoFramerate === 0 && isWorkerBusy.current) || (inputSource === 'file' && !videoFileUrl)}
                     >
                        {videoFramerate === 0 
                           ? (isWorkerBusy.current ? '...' : 'Run') 
                           : (isAnalysisRunning ? 'Stop' : 'Loop')}
                     </button>
                  </div>
               </div>
            </div>

            {/* Video & Output Split */}
            <div className="flex-1 flex flex-col lg:flex-row gap-4 min-h-0">
               {/* Video Feed */}
               <div className="flex-1 bg-black rounded-xl overflow-hidden relative flex items-center justify-center border border-gray-800">
                  <video 
                     ref={videoRef} 
                     autoPlay 
                     playsInline 
                     loop={inputSource === 'file'} // Loop file videos for continuous analysis
                     muted 
                     controls={inputSource === 'file'} // Show controls only for files
                     className="max-w-full max-h-full object-contain"
                  ></video>
                  <canvas ref={canvasRef} className="hidden"></canvas>
                  
                  {/* Overlay Status */}
                  <div className="absolute top-2 right-2 bg-black/60 text-white text-xs px-2 py-1 rounded backdrop-blur-sm z-10 pointer-events-none">
                     {isAnalysisRunning ? '● Analyzing' : '○ Standby'}
                  </div>
               </div>

               {/* Output Panel */}
               <div className="flex-1 bg-gray-50 dark:bg-gray-800 rounded-xl p-4 border border-gray-200 dark:border-gray-700 flex flex-col min-h-[200px]">
                  <div className="flex justify-between items-center mb-2 border-b border-gray-200 dark:border-gray-700 pb-2">
                     <h3 className="font-semibold text-gray-700 dark:text-gray-200">Model Output</h3>
                     {tps && <span className="text-xs text-gray-500">{tps.toFixed(1)} tok/s</span>}
                  </div>
                  <div className="flex-1 overflow-y-auto whitespace-pre-wrap font-mono text-sm leading-relaxed text-gray-800 dark:text-gray-300">
                     {modelOutput || <span className="text-gray-400 italic">Output will appear here...</span>}
                  </div>
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