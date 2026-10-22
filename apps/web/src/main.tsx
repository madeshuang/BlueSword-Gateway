import {createRoot} from "react-dom/client";
import {BoothApp} from "./BoothApp";
import {DeveloperRecords} from "./DeveloperRecords";
const path=location.pathname;
createRoot(document.getElementById("root")!).render(path==="/developer/speech"?<DeveloperRecords kind="speech"/>:path==="/developer/robot"?<DeveloperRecords kind="robot"/>:<BoothApp />);
