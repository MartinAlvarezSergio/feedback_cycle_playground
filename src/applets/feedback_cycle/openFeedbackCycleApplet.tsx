import { OpenAppletOptions, OpenedApplet } from "../../core/host";
import { FeedbackCycleCanvas } from "./FeedbackCycleCanvas";

export function openFeedbackCycleApplet(options?: OpenAppletOptions): OpenedApplet {
  return {
    id: "feedback-cycle",
    title: "Stars and feedback",
    description:
      "A cinematic, simulated patch of a galaxy's disk: dense gas forms stars (Kennicutt–Schmidt), supernovae heat and blow the gas apart, and star formation regulates itself. Compared with the same patch without feedback.",
    close: () => {
      options?.host?.onClose?.();
    },
    render: () => <FeedbackCycleCanvas host={options?.host} />
  };
}
