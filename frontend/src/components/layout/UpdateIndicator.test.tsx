import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUpdateStore } from "@/stores/update-store";
import type { UpdateState } from "@/types";
import { StatusBar } from "./StatusBar";
import { UpdateIndicator } from "./UpdateIndicator";

const base: UpdateState = { revision: 1, phase: "idle", mode: "installer", currentVersion: "0.1.2", autoCheck: true, lastCheckedAt: new Date().toISOString() };

function setUpdate(patch: Partial<UpdateState>) {
  act(() => useUpdateStore.setState({ state: { ...base, ...patch } }));
}

function openMenu(name: RegExp) {
  const trigger = screen.getByRole("button", { name });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "Enter" });
}

describe("UpdateIndicator", () => {
  beforeEach(() => {
    useUpdateStore.setState({ state: undefined });
  });

  it("renders nothing until the backend reports and a plain version in development", () => {
    const { container } = render(<UpdateIndicator />);
    expect(container).toBeEmptyDOMElement();
    setUpdate({ mode: "off", modeReason: "Updates are disabled in development builds." });
    expect(screen.getByText("v0.1.2")).toHaveAttribute("title", "Updates are disabled in development builds.");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("lives in the status bar and offers download, release notes, and skip", () => {
    const download = vi.fn().mockResolvedValue(undefined);
    const skip = vi.fn().mockResolvedValue(undefined);
    useUpdateStore.setState({ download, skip });
    render(<StatusBar activeJobs={0} />);
    setUpdate({ phase: "available", availableVersion: "0.2.0" });

    openMenu(/Update 0\.2\.0, update options/);
    expect(screen.getByText("Version 0.2.0 is available.")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Release notes/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Skip this version/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: /Download 0\.2\.0/ }));

    expect(download).toHaveBeenCalledOnce();
    expect(skip).not.toHaveBeenCalled();
  });

  it("keeps the menu open for a manual check and persists the automatic-check preference", () => {
    const check = vi.fn().mockResolvedValue(undefined);
    const setAutoCheck = vi.fn().mockResolvedValue(undefined);
    useUpdateStore.setState({ check, setAutoCheck });
    render(<UpdateIndicator />);
    setUpdate({});

    openMenu(/Duc's Table 0\.1\.2, update options/);
    fireEvent.click(screen.getByRole("menuitem", { name: /Check for updates/ }));
    expect(check).toHaveBeenCalledOnce();
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Check automatically" }));
    expect(setAutoCheck).toHaveBeenCalledWith(false);
  });

  it("explains fallbacks and links to GitHub when the app cannot update itself", () => {
    const openRelease = vi.fn().mockResolvedValue(undefined);
    useUpdateStore.setState({ openRelease });
    render(<UpdateIndicator />);
    setUpdate({ phase: "available", mode: "notify", availableVersion: "0.2.0", modeReason: "This build is not signed with a Developer ID, so updates cannot be verified automatically." });

    openMenu(/Update 0\.2\.0/);
    expect(screen.getByText(/not signed with a Developer ID/)).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Release notes/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: /Get 0\.2\.0 on GitHub/ }));
    expect(openRelease).toHaveBeenCalledOnce();
  });

  it("shows download progress and errors", () => {
    render(<UpdateIndicator />);
    setUpdate({ phase: "downloading", availableVersion: "0.2.0", progress: 40, downloadedBytes: 40, totalBytes: 100, error: undefined });
    openMenu(/Downloading 40%/);
    expect(screen.getByRole("progressbar", { name: "Update download progress" })).toHaveAttribute("aria-valuenow", "40");
    expect(screen.queryByRole("menuitem", { name: /Skip this version/ })).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Check for updates/ })).toHaveAttribute("data-disabled");

    setUpdate({ phase: "available", availableVersion: "0.2.0", error: "The update could not be downloaded and verified: checksum mismatch" });
    expect(screen.getByRole("alert")).toHaveTextContent("checksum mismatch");
  });

  it("asks before restarting while jobs are running", () => {
    const install = vi.fn().mockResolvedValue(undefined);
    useUpdateStore.setState({ install });
    render(<UpdateIndicator activeJobs={2} />);
    setUpdate({ phase: "ready", availableVersion: "0.2.0" });

    openMenu(/Restart to update, update options/);
    fireEvent.click(screen.getByRole("menuitem", { name: /Restart to update/ }));
    expect(install).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toHaveTextContent("2 jobs are still running");

    fireEvent.click(screen.getByRole("button", { name: "Restart and update" }));
    expect(install).toHaveBeenCalledOnce();
  });

  it("installs immediately when nothing is running", () => {
    const install = vi.fn().mockResolvedValue(undefined);
    useUpdateStore.setState({ install });
    render(<UpdateIndicator activeJobs={0} />);
    setUpdate({ phase: "ready", availableVersion: "0.2.0" });

    openMenu(/Restart to update/);
    fireEvent.click(screen.getByRole("menuitem", { name: /Restart to update/ }));
    expect(install).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
});
