# Roomtone

[Open the studio on GitHub Pages](https://ari-ahm.github.io/AR-Concert/).

A buildless, client-side spatial listening studio. Serve `dist/` over HTTPS for a phone. For a desktop preview from this repository, run `python -m http.server 8197 --directory dist` and open http://localhost:8197. On Android with USB debugging enabled, `adb reverse tcp:8197 tcp:8197` makes the same localhost URL available in phone Chrome. Mobile camera and immersive tracking require a secure context.

Load one local audio file and connect stereo earbuds. The initial pair receives left and right channels. Added speakers receive the same song mixed to mono. Local audio, video frames, and room observations stay in the browser. Session positions last until the page is closed or a new scan establishes a new origin. The phone represents the listener's pose.

- **Walk & scan** uses WebXR hit testing and the runtime's camera/IMU tracking. Slowly sweep across walls and floors. Native plane polygons are used when exposed. Otherwise repeated coplanar hits form finite surface patches. Open **Map** to orbit the live 3D view. Double-tap or use **Place speaker**, and drag to move. In-air gestures additionally require the runtime to grant raw camera access.
- **Selfie mode** uses 150 mm printed markers and an approximate focal length. Mount marker 0 upright, flat against a wall behind you. Introduce other markers in the same frame as a known marker to register more surfaces. Known markers give camera position and orientation. When orientation sensor data is available it supplies rotation between camera observations. Losing sight of a known marker pauses placement. Each marker identifies its own measured patch. This mode does not infer the extent of an unmarked wall.
- **Room acoustics** uses measured finite polygons for first-order image-source reflections (up to four per speaker). A fitted rectangular enclosure estimates late reverberation from the selected material preset. Until surfaces are mapped, the rectangular model also supplies early reflections. Open space, furniture diffraction, and independently moving head pose are not modeled.

## Reused components

Local upstream clones are in the project-level `upstream/` folder. Shipped assets have accompanying licenses in `dist/vendor/`.

- [MediaPipe](https://github.com/google-ai-edge/mediapipe), Tasks Vision 0.10.21. Model/runtime sources and checksums are recorded in `dist/vendor/mediapipe/SOURCES.txt`.
- [Resonance Audio Web SDK](https://github.com/resonance-audio/resonance-audio-web-sdk), commit `c69e41dae836aea5b41cf4e9e51efcd96e5d0bb6`.
- [js-aruco2](https://github.com/damianofalcioni/js-aruco2), commit `0491d5d228746411d0e9dd602b98f48636a644ba`. Printed markers use ARUCO_MIP_36h12 IDs 0 through 3.
