import { useState, useRef, useCallback, useEffect } from "react";

const BUFFER_SIZE = 4096;

function float32ToInt16(float32Array: Float32Array): Int16Array {
  const int16Array = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    let sample = Math.max(-1, Math.min(1, float32Array[i]));
    int16Array[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return int16Array;
}

export function useSystemAudio() {
  const [isActive, setIsActive] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const onAudioDataRef = useRef<((data: ArrayBuffer, sampleRate: number) => void) | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);

  const updateAudioLevel = useCallback(() => {
    if (!analyserRef.current) return;
    
    const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
    analyserRef.current.getByteFrequencyData(dataArray);
    
    const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
    setAudioLevel(Math.min(100, Math.round((average / 255) * 100)));
    
    animationFrameRef.current = requestAnimationFrame(updateAudioLevel);
  }, []);

  const cleanupAudio = useCallback(() => {
    if (processorRef.current) {
      try {
        processorRef.current.disconnect();
      } catch (e) {}
      processorRef.current = null;
    }
    
    if (workletNodeRef.current) {
      try {
        workletNodeRef.current.disconnect();
      } catch (e) {}
      workletNodeRef.current = null;
    }
    
    if (sourceRef.current) {
      try {
        sourceRef.current.disconnect();
      } catch (e) {}
      sourceRef.current = null;
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    if (analyserRef.current) {
      try {
        analyserRef.current.disconnect();
      } catch (e) {}
      analyserRef.current = null;
    }

    if (audioContextRef.current) {
      try {
        if (audioContextRef.current.state !== 'closed') {
          audioContextRef.current.close();
        }
      } catch (e) {}
      audioContextRef.current = null;
    }

    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    setIsActive(false);
    setAudioLevel(0);
    onAudioDataRef.current = null;
  }, []);

  const setupWithWorklet = async (
    audioContext: AudioContext,
    source: MediaStreamAudioSourceNode,
    sampleRate: number
  ): Promise<boolean> => {
    try {
      await audioContext.audioWorklet.addModule('/audio-processor.js');
      
      const workletNode = new AudioWorkletNode(audioContext, 'audio-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1,
      });
      workletNodeRef.current = workletNode;
      
      workletNode.port.onmessage = (event) => {
        if (onAudioDataRef.current && event.data.pcmData) {
          const pcmBuffer = event.data.pcmData;
          const actualSampleRate = event.data.sampleRate || sampleRate;
          onAudioDataRef.current(pcmBuffer, actualSampleRate);
        }
      };
      
      source.connect(workletNode);
      
      return true;
    } catch (e) {
      console.log("AudioWorklet not supported, falling back to ScriptProcessor");
      return false;
    }
  };

  const setupWithScriptProcessor = (
    audioContext: AudioContext,
    source: MediaStreamAudioSourceNode,
    sampleRate: number
  ) => {
    const processor = audioContext.createScriptProcessor(BUFFER_SIZE, 1, 1);
    processorRef.current = processor;
    
    processor.onaudioprocess = (event) => {
      if (onAudioDataRef.current) {
        const inputData = event.inputBuffer.getChannelData(0);
        const int16Data = float32ToInt16(inputData);
        const buffer = int16Data.buffer;
        onAudioDataRef.current(buffer, sampleRate);
      }
    };
    
    source.connect(processor);
    
    const silentGain = audioContext.createGain();
    silentGain.gain.value = 0;
    processor.connect(silentGain);
    silentGain.connect(audioContext.destination);
  };

  const startSystemAudio = useCallback(async (onAudioData: (data: ArrayBuffer, sampleRate: number) => void) => {
    cleanupAudio();
    
    try {
      setError(null);
      
      const stream = await (navigator.mediaDevices as any).getDisplayMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
        video: {
          mandatory: {
            chromeMediaSource: 'screen'
          }
        },
      } as any).catch(async () => {
        return (navigator.mediaDevices as any).getDisplayMedia({
          audio: {
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
          video: true,
        } as any);
      });

      streamRef.current = stream;
      onAudioDataRef.current = onAudioData;

      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      const audioContext = new AudioContextClass();
      audioContextRef.current = audioContext;
      
      if (audioContext.state === 'suspended') {
        await audioContext.resume();
      }
      
      const source = audioContext.createMediaStreamSource(stream);
      sourceRef.current = source;
      
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      analyserRef.current = analyser;
      
      const sampleRate = audioContext.sampleRate;
      
      const workletSuccess = await setupWithWorklet(audioContext, source, sampleRate);
      if (!workletSuccess) {
        const isScriptProcessorAvailable = typeof audioContext.createScriptProcessor === 'function';
        
        if (!isScriptProcessorAvailable) {
          cleanupAudio();
          setError("System audio capture is not supported on this browser.");
          setIsActive(false);
          return;
        }
        
        setupWithScriptProcessor(audioContext, source, sampleRate);
      }
      
      updateAudioLevel();

      setIsActive(true);
    } catch (err) {
      cleanupAudio();
      
      let message = "Failed to capture system audio";
      if (err instanceof Error) {
        if (err.name === 'NotAllowedError') {
          message = "System audio capture was cancelled. Please select a window or tab and allow audio.";
        } else if (err.name === 'NotSupportedError') {
          message = "System audio capture is not supported on this browser. Try Chrome or Edge.";
        } else {
          message = err.message;
        }
      }
      setError(message);
      setIsActive(false);
    }
  }, [updateAudioLevel, cleanupAudio]);

  const stopSystemAudio = cleanupAudio;

  useEffect(() => {
    return () => {
      if (streamRef.current || processorRef.current || audioContextRef.current || workletNodeRef.current) {
        cleanupAudio();
      }
    };
  }, [cleanupAudio]);

  return {
    isActive,
    audioLevel,
    error,
    startSystemAudio,
    stopSystemAudio,
  };
}
