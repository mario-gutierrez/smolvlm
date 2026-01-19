import { useEffect, useState, useRef, useCallback } from "react";

import Chat from "./components/Chat";
import ArrowRightIcon from "./components/icons/ArrowRightIcon";
import StopIcon from "./components/icons/StopIcon";
import Progress from "./components/Progress";
import ImageIcon from "./components/icons/ImageIcon";
import ImagePreview from "./components/ImagePreview";

const IS_WEBGPU_AVAILABLE = !!navigator.gpu;
const STICKY_SCROLL_THRESHOLD = 120;
const EXAMPLES = [
  {
    title: "Describe this image",
    text: "Can you describe this image?",
    images: [
      "https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/new-york.jpg",
    ],
  },
  {
    title: "Handwriting recognition",
    text: "What does this say?",
    images: [
      "https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/handwritten-math.jpg",
    ],
  },
  {
    title: "Chart analysis",
    text: "Where do the severe droughts happen according to this diagram?",
    images: [
      "https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/weather-events-diagram.png",
    ],
  },
];

function App() {
  // Create a reference to the worker object.
  const worker = useRef(null);

  const textareaRef = useRef(null);
  const chatContainerRef = useRef(null);
  const imageUploadRef = useRef(null);

  // Model loading and progress
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [loadingMessage, setLoadingMessage] = useState("");
  const [progressItems, setProgressItems] = useState([]);
  
  // App Mode State
  const [mode, setMode] = useState("chat"); // 'chat' or 'video'

  // Chat Mode State
  const [isRunning, setIsRunning] = useState(false);
  const [input, setInput] = useState("");
  const [images, setImages] = useState([]);
  const [messages, setMessages] = useState([]);
  const [tps, setTps] = useState(null);
  const [numTokens, setNumTokens] = useState(null);

  // Video Mode State
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const [cameras, setCameras] = useState([]);
  const [selectedCamera, setSelectedCamera] = useState("");
  const [videoFramerate, setVideoFramerate] = useState(0); // 0 = manual/stopped
  const [videoPrompt, setVideoPrompt] = useState("Describe this image");
  const [isVideoRunning, setIsVideoRunning] = useState(false);
  const [videoOutput, setVideoOutput] = useState("");
  const [videoTps, setVideoTps] = useState(null);
  const isWorkerBusy = useRef(false);
  const inferenceInterval = useRef(null);

  // --- Common Logic ---

  useEffect(() => {
    // Resize chat input
    if (mode === "chat") resizeInput();
  }, [input, mode]);

  function resizeInput() {
    if (!textareaRef.current) return;
    const target = textareaRef.current;
    target.style.height = "auto";
    const newHeight = Math.min(Math.max(target.scrollHeight, 24), 200);
    target.style.height = `${newHeight}px`;
  }

  // Worker Initialization
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
          if (mode === "chat") {
             setMessages((prev) => [
              ...prev,
              { role: "assistant", content: [{ type: "text", text: "" }] },
            ]);
          } else {
            setVideoOutput("");
          }
          break;

        case "update":
          const { output, tps, numTokens } = e.data;
          if (mode === "chat") {
            setTps(tps);
            setNumTokens(numTokens);
            setMessages((prev) => {
              const cloned = [...prev];
              const last = cloned.at(-1);
              if (last && last.role === 'assistant') {
                 cloned[cloned.length - 1] = {
                  ...last,
                  content: [{ type: "text", text: last.content[0].text + output }],
                };
              }
              return cloned;
            });
          } else {
             setVideoTps(tps);
             setVideoOutput((prev) => prev + output);
          }
          break;

        case "complete":
          isWorkerBusy.current = false;
          if (mode === "chat") {
             setIsRunning(false);
          } else {
             // If continuous "Max Speed" mode, trigger next frame immediately
             if (videoFramerate === -1 && isVideoRunning) {
                 triggerVideoInference();
             }
          }
          break;

        case "error":
          setError(e.data.data);
          isWorkerBusy.current = false;
          setIsRunning(false);
          setIsVideoRunning(false);
          break;
      }
    };

    const onErrorReceived = (e) => {
      console.error("Worker error:", e);
    };

    worker.current.addEventListener("message", onMessageReceived);
    worker.current.addEventListener("error", onErrorReceived);
    window.addEventListener("resize", resizeInput);

    return () => {
      worker.current.removeEventListener("message", onMessageReceived);
      worker.current.removeEventListener("error", onErrorReceived);
      window.removeEventListener("resize", resizeInput);
    };
  }, [mode, videoFramerate, isVideoRunning]);


  // --- Chat Mode Logic ---

  function onEnter(message, images) {
    const content = [
      ...images.map((image) => ({ type: "image", image })),
      { type: "text", text: message },
    ];
    setMessages((prev) => [...prev, { role: "user", content }]);
    setTps(null);
    setIsRunning(true);
    setInput("");
    setImages([]);
  }

  // Send messages to worker for Chat
  useEffect(() => {
    if (mode !== 'chat') return;
    if (messages.filter((x) => x.role === "user").length === 0) return;
    if (messages.at(-1).role === "assistant") return;
    setTps(null);
    isWorkerBusy.current = true;
    worker.current.postMessage({ type: "generate", data: messages });
  }, [messages, isRunning, mode]);

  useEffect(() => {
    if (!chatContainerRef.current || !isRunning) return;
    const element = chatContainerRef.current;
    if (
      element.scrollHeight - element.scrollTop - element.clientHeight <
      STICKY_SCROLL_THRESHOLD
    ) {
      element.scrollTop = element.scrollHeight;
    }
  }, [messages, isRunning]);


  // --- Video Mode Logic ---

  // Handle Camera Permission and Stream Start
  useEffect(() => {
    if (mode !== 'video') return;

    let currentStream = null;

    const setupCamera = async () => {
      try {
        // We request a stream immediately.
        // If 'selectedCamera' is set, we request that specific device.
        // If not, we request 'true' (any camera) to trigger the permission prompt.
        const constraints = selectedCamera 
          ? { video: { deviceId: { exact: selectedCamera } } } 
          : { video: true };

        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        currentStream = stream;

        // Attach stream to video element
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }

        // Once permission is granted and stream starts, we can safely enumerate devices
        // (Labels will now be visible)
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(d => d.kind === 'videoinput');
        setCameras(videoDevices);

        // If no camera was selected yet (first run), sync state with the actual active camera
        if (!selectedCamera && videoDevices.length > 0) {
           const videoTracks = stream.getVideoTracks();
           if (videoTracks.length > 0) {
              const activeDeviceId = videoTracks[0].getSettings().deviceId;
              if (activeDeviceId) {
                  setSelectedCamera(activeDeviceId);
              } else {
                  // Fallback if browser doesn't expose ID on the track settings
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
      if (currentStream) {
        currentStream.getTracks().forEach(track => track.stop());
      }
    };
  }, [mode, selectedCamera]);

  const captureFrame = useCallback(() => {
    if (!videoRef.current || !canvasRef.current) return null;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    
    if (video.readyState !== 4) return null; 

    const context = canvas.getContext('2d');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.8);
  }, []);

  const triggerVideoInference = useCallback(() => {
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

  // Handle Framerate Loop
  useEffect(() => {
    if (!isVideoRunning || mode !== 'video') {
      if (inferenceInterval.current) clearInterval(inferenceInterval.current);
      return;
    }

    if (videoFramerate > 0) {
      const intervalMs = 1000 / videoFramerate;
      inferenceInterval.current = setInterval(triggerVideoInference, intervalMs);
    } else if (videoFramerate === -1) {
       triggerVideoInference();
    }

    return () => {
      if (inferenceInterval.current) clearInterval(inferenceInterval.current);
    };
  }, [isVideoRunning, videoFramerate, mode, triggerVideoInference]);

  const toggleVideoAnalysis = () => {
    if (isVideoRunning) {
      setIsVideoRunning(false);
      worker.current.postMessage({ type: "interrupt" });
    } else {
      setIsVideoRunning(true);
    }
  };


  // --- Render ---

  const validInput = input.length > 0 && images.length > 0;

  return IS_WEBGPU_AVAILABLE ? (
    <div className="flex flex-col h-screen mx-auto text-gray-800 dark:text-gray-200 bg-white dark:bg-gray-900">
      
      {/* Header / Mode Switcher */}
      <div className="flex flex-col items-center pt-4 pb-2 px-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 shrink-0">
         <div className="flex items-center gap-4 mb-2">
            <div className="flex items-center gap-2">
               <img src="logo.png" className="w-8 h-8"/>
               <h1 className="text-xl font-bold">SmolVLM WebGPU</h1>
            </div>
            
            {status === "ready" && (
              <div className="flex bg-gray-200 dark:bg-gray-700 rounded-lg p-1">
                 <button 
                   onClick={() => setMode('chat')}
                   className={`px-4 py-1 rounded-md text-sm font-medium transition-colors ${mode === 'chat' ? 'bg-white dark:bg-gray-600 shadow-sm' : 'hover:text-gray-600 dark:hover:text-gray-400'}`}
                 >Chat</button>
                 <button 
                   onClick={() => setMode('video')}
                   className={`px-4 py-1 rounded-md text-sm font-medium transition-colors ${mode === 'video' ? 'bg-white dark:bg-gray-600 shadow-sm' : 'hover:text-gray-600 dark:hover:text-gray-400'}`}
                 >Live Video</button>
              </div>
            )}
         </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 overflow-hidden relative flex flex-col">
      
      {status === null && (
        <div className="h-full overflow-auto scrollbar-thin flex justify-center items-center flex-col relative p-4">
            <h2 className="text-2xl font-semibold text-center mb-4">
              The smallest multimodal model in the world.<br />
              Designed for efficiency.
            </h2>
            <p className="max-w-[500px] mb-6 text-center text-gray-600 dark:text-gray-400">
              You are about to load <span className="font-semibold">SmolVLM-256M-Instruct</span>. 
              Everything runs entirely in your browser using WebGPU.
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

      {status === "ready" && mode === "chat" && (
        <>
          <div
            ref={chatContainerRef}
            className="flex-1 overflow-y-auto scrollbar-thin flex flex-col items-center w-full"
          >
            <Chat messages={messages} />
            {messages.length === 0 && (
              <div className="flex flex-wrap justify-center gap-2 mt-8">
                {EXAMPLES.map((msg, i) => (
                  <div
                    key={i}
                    className="w-64 border border-gray-300 dark:border-gray-600 rounded-xl p-3 bg-gray-50 dark:bg-gray-800 cursor-pointer hover:border-blue-400 transition-colors"
                    onClick={() => onEnter(msg.text, msg.images)}
                  >
                    <p className="font-medium text-sm mb-2">{msg.text}</p>
                    <div className="flex gap-1 overflow-hidden rounded-md">
                    {msg.images.map((src, j) => (
                      <img key={j} src={src} className="h-20 w-full object-cover" alt="Example" />
                    ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
             <div className="h-4 shrink-0"></div>
          </div>
          
          {/* Chat Input Area */}
          <div className="p-4 bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-700">
            <div className="max-w-3xl mx-auto">
               {/* Stats */}
               <div className="text-center text-xs text-gray-500 dark:text-gray-400 mb-2 h-5">
                {tps && (
                  <span>
                    Generated {numTokens} tokens ({tps.toFixed(2)} tok/s)
                    {!isRunning && <span className="ml-2 underline cursor-pointer hover:text-gray-800 dark:hover:text-gray-200" onClick={() => { worker.current.postMessage({ type: "reset" }); setMessages([]); }}>Reset Chat</span>}
                  </span>
                )}
               </div>

               <div className="border border-gray-300 dark:border-gray-600 rounded-xl bg-gray-50 dark:bg-gray-800 p-2 flex flex-col gap-2 relative shadow-sm focus-within:ring-2 focus-within:ring-blue-500/20">
                  {images.length > 0 && (
                     <div className="flex gap-2 px-2 pt-2 overflow-x-auto">
                        {images.map((src, i) => (
                          <ImagePreview
                            key={i}
                            onRemove={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                            src={src}
                            className="w-16 h-16 min-w-16 min-h-16 relative"
                          />
                        ))}
                     </div>
                  )}
                  
                  <div className="flex items-end gap-2">
                     <label className="p-2 cursor-pointer text-gray-500 hover:text-blue-500 transition-colors">
                        <ImageIcon className="w-6 h-6" />
                        <input
                          ref={imageUploadRef}
                          type="file"
                          accept="image/*"
                          className="hidden"
                          multiple
                          onInput={async (e) => {
                            const files = Array.from(e.target.files);
                            if (files.length === 0) return;
                            const readers = files.map((file) => new Promise((resolve) => {
                                const reader = new FileReader();
                                reader.onload = (e) => resolve(e.target.result);
                                reader.readAsDataURL(file);
                            }));
                            const results = await Promise.all(readers);
                            setImages((prev) => [...prev, ...results]);
                            e.target.value = "";
                          }}
                        />
                     </label>
                     
                     <textarea
                        ref={textareaRef}
                        className="flex-1 bg-transparent border-none outline-none py-2 text-gray-800 dark:text-gray-100 placeholder-gray-400 resize-none max-h-[150px]"
                        placeholder="Type a message..."
                        rows={1}
                        value={input}
                        onKeyDown={(e) => {
                          if (validInput && !isRunning && e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            onEnter(input, images);
                          }
                        }}
                        onInput={(e) => setInput(e.target.value)}
                     />
                     
                     <button
                        className={`p-2 rounded-lg ${validInput && !isRunning ? 'bg-blue-500 text-white' : 'bg-gray-200 dark:bg-gray-700 text-gray-400'}`}
                        onClick={() => validInput && !isRunning && onEnter(input, images)}
                        disabled={!validInput || isRunning}
                     >
                        {isRunning ? <StopIcon className="w-5 h-5 animate-pulse" onClick={(e) => { e.stopPropagation(); worker.current.postMessage({ type: "interrupt" }); }} /> : <ArrowRightIcon className="w-5 h-5" />}
                     </button>
                  </div>
               </div>
            </div>
          </div>
        </>
      )}

      {status === "ready" && mode === "video" && (
        <div className="flex-1 flex flex-col p-4 gap-4 h-full overflow-hidden max-w-6xl mx-auto w-full">
            {/* Video Controls */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 bg-gray-100 dark:bg-gray-800 p-4 rounded-xl">
               <div className="flex flex-col gap-1">
                  <label className="text-xs font-semibold uppercase text-gray-500">Camera</label>
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
               </div>
               
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

               <div className="flex flex-col gap-1 lg:col-span-2">
                  <label className="text-xs font-semibold uppercase text-gray-500">Prompt for every frame</label>
                  <div className="flex gap-2">
                     <input 
                       type="text" 
                       className="flex-1 p-2 rounded bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 text-sm"
                       value={videoPrompt}
                       onChange={(e) => setVideoPrompt(e.target.value)}
                     />
                     <button
                        onClick={videoFramerate === 0 ? triggerVideoInference : toggleVideoAnalysis}
                        className={`px-4 py-2 rounded font-medium text-white transition-colors ${
                           videoFramerate === 0 
                             ? (isWorkerBusy.current ? 'bg-gray-400 cursor-not-allowed' : 'bg-blue-500 hover:bg-blue-600')
                             : (isVideoRunning ? 'bg-red-500 hover:bg-red-600' : 'bg-green-500 hover:bg-green-600')
                        }`}
                        disabled={videoFramerate === 0 && isWorkerBusy.current}
                     >
                        {videoFramerate === 0 
                           ? (isWorkerBusy.current ? 'Processing...' : 'Analyze Now') 
                           : (isVideoRunning ? 'Stop Loop' : 'Start Loop')}
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
                     muted 
                     className="max-w-full max-h-full object-contain"
                  ></video>
                  <canvas ref={canvasRef} className="hidden"></canvas>
                  
                  {/* Overlay Status */}
                  <div className="absolute top-2 right-2 bg-black/60 text-white text-xs px-2 py-1 rounded backdrop-blur-sm">
                     {isVideoRunning ? '● Live Inference' : '○ Standby'}
                  </div>
               </div>

               {/* Output Panel */}
               <div className="flex-1 bg-gray-50 dark:bg-gray-800 rounded-xl p-4 border border-gray-200 dark:border-gray-700 flex flex-col min-h-[200px]">
                  <div className="flex justify-between items-center mb-2 border-b border-gray-200 dark:border-gray-700 pb-2">
                     <h3 className="font-semibold text-gray-700 dark:text-gray-200">Model Output</h3>
                     {videoTps && <span className="text-xs text-gray-500">{videoTps.toFixed(1)} tok/s</span>}
                  </div>
                  <div className="flex-1 overflow-y-auto whitespace-pre-wrap font-mono text-sm leading-relaxed text-gray-800 dark:text-gray-300">
                     {videoOutput || <span className="text-gray-400 italic">Output will appear here...</span>}
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