chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("kakao-lists-sync", { periodInMinutes: 60 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "kakao-lists-sync") {
    console.info("Scheduled sync placeholder fired.");
  }
});

