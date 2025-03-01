const codec = "audio/mpeg";
const maxBufferDuration = 90;
let streamingCompleted = true;
const mediaSource = new MediaSource();
const audioElement = new Audio();

let buttonState = "play";
const setButtonState = (state) => {
  if (state === "loading") {
    buttonState = "loading";
  } else if (state === "play") {
    buttonState = "play";
    audioElement.pause();
  } else if (state === "speak") {
    buttonState = "speak";
  }
};

let textToPlay = "";
const setTextToPlay = (text) => {
  textToPlay = text;
};

const readStorage = async (keys) => {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, function (result) {
      resolve(result);
    });
  });
};

const fetchResponse = async () => {
  const storage = await readStorage(["apiKey", "selectedVoiceId", "mode"]);
  const selectedVoiceId = storage.selectedVoiceId
    ? storage.selectedVoiceId
    : "21m00Tcm4TlvDq8ikWAM"; //fallback Voice ID
  const mode = storage.mode
  const model_id =
    (mode === "englishfast" || mode === "eleven_turbo_v2") ? "eleven_turbo_v2" :
      (mode === "multilingual" || mode === "eleven_multilingual_v2") ? "eleven_multilingual_v2" :
        "eleven_turbo_v2_5";

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${selectedVoiceId}/stream`,
    {
      method: "POST",
      headers: {
        Accept: codec,
        "xi-api-key": storage.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model_id: model_id,
        text: textToPlay,
        voice_settings: {
          similarity_boost: 0.5,
          stability: 0.5,
        },
      }),
    }
  );
  return response;
};

const handleMissingApiKey = () => {
  setButtonState("speak");
  const audio = new Audio(chrome.runtime.getURL("media/error-no-api-key.mp3"));
  audio.play();
  //since alert() is blocking, timeout is needed so audio plays while alert is visible.
  setTimeout(() => {
    alert(
      "Please set your Elevenlabs API key in the extension settings to use Human Reader."
    );
    chrome.storage.local.clear();
    setButtonState("play");
  }, 100);
};

const clearBuffer = () => {
  if (mediaSource.readyState === "open") {
    const sourceBuffers = mediaSource.sourceBuffers;
    for (let i = 0; i < sourceBuffers.length; i++) {
      sourceBuffers[i].abort();
      mediaSource.removeSourceBuffer(sourceBuffers[i]);
    }
  }
  audioElement.pause();
  audioElement.src = "";
  streamingCompleted = true;
};

const stopAudio = () => {
  isStopped = true;
  clearBuffer();
  setButtonState("play");
};

let sourceOpenEventAdded = false;
const streamAudio = async () => {
  const storage = await readStorage(["apiKey", "speed"]);
  if (!storage.apiKey) {
    handleMissingApiKey();
    return;
  }
  isStopped = false;
  streamingCompleted = false;
  audioElement.src = URL.createObjectURL(mediaSource);
  const playbackRate = storage.speed ? storage.speed : 1;
  audioElement.playbackRate = playbackRate;
  audioElement.play();
  if (!sourceOpenEventAdded) {
    sourceOpenEventAdded = true;
    mediaSource.addEventListener("sourceopen", () => {
      const sourceBuffer = mediaSource.addSourceBuffer(codec);

      let isAppending = false;
      let appendQueue = [];

      const processAppendQueue = () => {
        if (!isAppending && appendQueue.length > 0) {
          isAppending = true;
          const chunk = appendQueue.shift();
          if (chunk && mediaSource.sourceBuffers.length > 0) {
            sourceBuffer.appendBuffer(chunk);
          } else {
            isAppending = false;
          }
        }
      };

      sourceBuffer.addEventListener("updateend", () => {
        isAppending = false;
        processAppendQueue();
      });

      const appendChunk = (chunk) => {
        if (isStopped) return;

        setButtonState("speak");
        appendQueue.push(chunk);
        processAppendQueue();

        while (
          mediaSource.duration - mediaSource.currentTime >
          maxBufferDuration
        ) {
          const removeEnd = mediaSource.currentTime - maxBufferDuration;
          sourceBuffer.remove(0, removeEnd);
        }
      };

      const fetchAndAppendChunks = async () => {
        try {
          const response = await fetchResponse();

          if (response.status === 401) {
            const errorBody = await response.json();
            const errorStatus = errorBody.detail.status
            if (errorStatus === "detected_unusual_activity" || errorStatus === "quota_exceeded") {
              alert(`MESSAGE FROM ELEVENLABS: ${errorBody.detail.message}`);
            } else {
              alert("Unauthorized. Please set your API key again.");
              chrome.storage.local.clear();
            }
            setButtonState("play");
            return;
          }

          if (!response.body) {
            const errorMessage = "Error fetching audio, please try again";
            alert(errorMessage);
            console.error(errorMessage);
            setButtonState("play");
            return;
          }

          const reader = response.body.getReader();

          while (true) {
            const { done, value } = await reader.read();

            if (done) {
              // Signal the end of the stream
              streamingCompleted = true;
              break;
            }

            appendChunk(value.buffer);
          }
        } catch (error) {
          setButtonState("play");
          console.error("Error fetching and appending chunks:", error);
        }
      };
      fetchAndAppendChunks();
    });
  }
};

async function onClickTtsButton() {
  if (buttonState === "loading" || buttonState === "speak") {
    stopAudio();
    return;
  }
  setButtonState("loading");
  try {
    setTextToPlay(window.getSelection().toString());
    await streamAudio();
  } catch (error) {
    console.error(error);
    setButtonState("play");
  }
}

audioElement.addEventListener("timeupdate", () => {
  // This is a hacky way to deterimne that the audio has ended. I couldn't find a better way to do it.
  // If you have an idea, please let me know.
  const playbackEndThreshold = 0.5;
  if (streamingCompleted) {
    if (audioElement.buffered.length > 0) {
      const bufferEndTime = audioElement.buffered.end(audioElement.buffered.length - 1);
      const timeLeft = bufferEndTime - audioElement.currentTime;

      if (timeLeft <= playbackEndThreshold) {
        setButtonState("play");
      }
    }
  }
});


// Receive sent message from background worker and trigger readOutLoud action
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "readOutLoud") {
    onClickTtsButton();
  }
  return true
});

document.addEventListener("keydown", function (e) {
  if ((e.ctrlKey || e.metaKey) && e.key === "h") {
    onClickTtsButton();
  }
});