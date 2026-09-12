# PitchClipers

PitchClipers is a computer-vision course project for generating labeled, event-centered highlight candidates from football broadcast video. The selected research direction uses a pretrained, feature-based SoccerNet-v2 action-spotting model and converts detected event timestamps into reviewable and exportable clips.

## Project status

The repository currently contains:

- a React/Vite interface for uploading a match, selecting event classes, tracking processing, and reviewing generated clips;
- the one-page research proposal in LaTeX and PDF formats;
- project branding and research notes relevant to the selected approach.

The next milestone is a feasibility experiment with the pretrained [Yahoo Spivak](https://github.com/yahoo/spivak) model on released SoccerNet-v2 ResNet/PCA512 features. The model backend is not yet included; the interface currently expects an asynchronous backend API.

## Selected research scope

The system will focus on SoccerNet-v2 action spotting for events such as:

- goals and penalties;
- shots on and off target;
- fouls and cards;
- corners, free kicks, offsides, and substitutions.

The research experiment compares a single global confidence threshold with thresholds calibrated per event class. Point detections are converted into event-specific clip windows, and overlapping detections are merged into coherent highlight candidates.

## Run the frontend

Requirements:

- Node.js 20 or newer
- npm

Install and start the development server:

```bash
npm install
npm run dev
```

Open `http://127.0.0.1:5173`.

Create a production build with:

```bash
npm run build
```

## Local fixture mode

The default local mode runs entirely in the browser. Choose a video to preview it, select one or more of the six supported event classes, and click **Run local fixture**. The deterministic fixture adapter generates demo events and clip windows without uploading the video or requiring a model checkpoint.

The local workflow supports confidence filtering, timeline seeking, clip selection and ordering, and JSON/CSV manifest export. Fixture results are for interface testing and are labelled as such; they are not model predictions.

To switch to the asynchronous backend workflow, set the following in `.env`:

```bash
VITE_APP_MODE=api
VITE_BACKEND_API_URL=http://127.0.0.1:8000
```

## Backend configuration

By default, Vite proxies `/api` requests to `http://127.0.0.1:8000`. To use another backend, copy `.env.example` to `.env` and set:

```bash
VITE_BACKEND_API_URL=http://your-backend-host:8000
```

The API mode expects endpoints for:

- initiating a match-processing job;
- uploading the corresponding video;
- starting asynchronous processing;
- receiving progress through Server-Sent Events or polling;
- listing and playing generated clips.

## Repository structure

```text
.
├── docs/             Brand and project documentation
├── output/pdf/       Compiled proposal PDF
├── proposal/         LaTeX proposal source
├── src/              React application
├── .env.example      Backend configuration example
└── package.json      Frontend scripts and dependencies
```

Datasets, checkpoints, uploaded videos, generated clips, and model outputs are intentionally excluded from version control. Store large experiment data in workstation-local temporary storage rather than the shared home directory.

## Research references

- [SoccerNet-v2: A Dataset and Benchmarks for Holistic Understanding of Broadcast Soccer Videos](https://openaccess.thecvf.com/content/CVPR2021W/CVSports/html/Deliege_SoccerNet-v2_A_Dataset_and_Benchmarks_for_Holistic_Understanding_of_Broadcast_CVPRW_2021_paper.html)
- [Temporally Precise Action Spotting in Soccer Videos Using Dense Detection Anchors](https://arxiv.org/abs/2205.10450)
- [Spivak pretrained action-spotting models and code](https://github.com/yahoo/spivak)
- [A Context-Aware Loss Function for Action Spotting in Soccer Videos](https://openaccess.thecvf.com/content_CVPR_2020/html/Cioppa_A_Context-Aware_Loss_Function_for_Action_Spotting_in_Soccer_Videos_CVPR_2020_paper.html)
- [Temporally-Aware Feature Pooling for Action Spotting in Soccer Broadcasts](https://openaccess.thecvf.com/content/CVPR2021W/CVSports/html/Giancola_Temporally-Aware_Feature_Pooling_for_Action_Spotting_in_Soccer_Broadcasts_CVPRW_2021_paper.html)
