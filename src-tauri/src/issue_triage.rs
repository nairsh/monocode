//! Temporary repository workspaces for triage through the normal agent adapters.
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{Mutex, OnceLock},
};

static WORKSPACES: OnceLock<Mutex<HashMap<String, Workspace>>> = OnceLock::new();

fn git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let mut command = Command::new("git");
    command.current_dir(cwd).args(args);
    crate::hide_window_console(&mut command);
    let output = command.output().map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(format!(
            "Could not prepare triage workspace: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

struct Workspace {
    repo: PathBuf,
    path: PathBuf,
    head: String,
}
impl Workspace {
    fn new(cwd: &str) -> Result<Self, String> {
        let repo =
            fs::canonicalize(crate::fs::expand_home(cwd)).map_err(|error| error.to_string())?;
        git(&repo, &["rev-parse", "--show-toplevel"])?;
        let head = git(&repo, &["rev-parse", "HEAD"])?;
        let path = std::env::temp_dir().join(format!("monocode-triage-{}", uuid::Uuid::new_v4()));
        let path_text = path.to_str().ok_or("Invalid triage workspace path")?;
        git(
            &repo,
            &["worktree", "add", "--detach", path_text, head.trim()],
        )?;
        Ok(Self { repo, path, head })
    }

    fn validate_file(&self, relative: &str) -> Result<(), String> {
        let path = Path::new(relative);
        if relative.is_empty()
            || relative.contains('\\')
            || path
                .components()
                .any(|component| !matches!(component, std::path::Component::Normal(_)))
            || relative.split('/').any(|part| part == ".git")
        {
            return Err("Choose a repository-relative source file".into());
        }
        let resolved = fs::canonicalize(self.path.join(path)).map_err(|error| error.to_string())?;
        let root = fs::canonicalize(&self.path).map_err(|error| error.to_string())?;
        if !resolved.starts_with(root) || !resolved.is_file() {
            return Err("File is outside the triage workspace".into());
        }
        git(&self.path, &["ls-files", "--error-unmatch", "--", relative])?;
        Ok(())
    }

    fn validate_plan(&self, plan: &Value) -> Result<(), String> {
        let groups = plan["groups"]
            .as_array()
            .filter(|groups| !groups.is_empty())
            .ok_or("Triage returned no groups")?;
        for group in groups {
            let files = group["files"]
                .as_array()
                .filter(|files| !files.is_empty())
                .ok_or("Each triage group must cite tracked source files")?;
            for file in files {
                self.validate_file(file.as_str().ok_or("Invalid source file citation")?)?;
            }
        }
        if git(&self.path, &["rev-parse", "HEAD"])? != self.head
            || !git(&self.path, &["status", "--porcelain"])?
                .trim()
                .is_empty()
        {
            return Err("The triage agent changed its checkout instead of only analyzing it. Retry with another model.".into());
        }
        Ok(())
    }
}
impl Drop for Workspace {
    fn drop(&mut self) {
        if let Some(path) = self.path.to_str() {
            // Only this generated checkout is removed; never the user's working copy.
            let _ = git(&self.repo, &["worktree", "remove", "--force", path]);
        }
    }
}

#[derive(Serialize)]
pub struct WorkspaceInfo {
    id: String,
    path: String,
}

#[tauri::command(async)]
pub fn issue_triage_open(cwd: String) -> Result<WorkspaceInfo, String> {
    let workspace = Workspace::new(&cwd)?;
    let info = WorkspaceInfo {
        id: uuid::Uuid::new_v4().to_string(),
        path: workspace
            .path
            .to_str()
            .ok_or("Invalid triage workspace path")?
            .to_owned(),
    };
    WORKSPACES
        .get_or_init(Mutex::default)
        .lock()
        .map_err(|_| "Triage workspace registry unavailable")?
        .insert(info.id.clone(), workspace);
    Ok(info)
}

#[tauri::command(async)]
pub fn issue_triage_validate(id: String, plan: Value) -> Result<(), String> {
    let workspaces = WORKSPACES
        .get_or_init(Mutex::default)
        .lock()
        .map_err(|_| "Triage workspace registry unavailable")?;
    workspaces
        .get(&id)
        .ok_or("The triage workspace is no longer available")?
        .validate_plan(&plan)
}

#[tauri::command(async)]
pub fn issue_triage_close(id: String) -> Result<(), String> {
    let workspace = WORKSPACES
        .get_or_init(Mutex::default)
        .lock()
        .map_err(|_| "Triage workspace registry unavailable")?
        .remove(&id);
    drop(workspace);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn workspace_is_isolated_and_citations_cannot_escape() {
        // Exercise both Git checkout conventions, including Windows CRLF conversion.
        for autocrlf in ["false", "true"] {
            let repo =
                std::env::temp_dir().join(format!("monocode-triage-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&repo).unwrap();
            git(&repo, &["init"]).unwrap();
            git(&repo, &["config", "core.autocrlf", autocrlf]).unwrap();
            fs::write(repo.join("source.txt"), "committed source\nsecond line\n").unwrap();
            git(&repo, &["add", "source.txt"]).unwrap();
            git(
                &repo,
                &[
                    "-c",
                    "user.name=Triage Test",
                    "-c",
                    "user.email=triage@test",
                    "commit",
                    "-m",
                    "fixture",
                ],
            )
            .unwrap();
            fs::write(repo.join("source.txt"), "uncommitted changes").unwrap();
            let workspace = Workspace::new(repo.to_str().unwrap()).unwrap();
            let path = workspace.path.clone();
            let source = fs::read_to_string(path.join("source.txt")).unwrap();
            assert_eq!(
                source.replace("\r\n", "\n"),
                "committed source\nsecond line\n"
            );
            let plan = json!({"groups":[{"files":["source.txt"]}], "dependencies":[]});
            workspace.validate_plan(&plan).unwrap();
            for file in [
                "../source.txt",
                "/etc/passwd",
                ".git",
                "missing",
                "a\\..\\source.txt",
            ] {
                assert!(workspace.validate_file(file).is_err());
            }
            fs::write(path.join("untracked.txt"), "not source evidence").unwrap();
            assert!(workspace.validate_file("untracked.txt").is_err());
            assert!(workspace
                .validate_plan(&plan)
                .unwrap_err()
                .contains("changed"));
            assert!(workspace
                .validate_plan(&json!({"groups":[{"files":[]}]}))
                .is_err());
            git(&path, &["add", "untracked.txt"]).unwrap();
            git(
                &path,
                &[
                    "-c",
                    "user.name=Triage Test",
                    "-c",
                    "user.email=triage@test",
                    "commit",
                    "-m",
                    "unexpected agent commit",
                ],
            )
            .unwrap();
            assert!(workspace
                .validate_plan(&plan)
                .unwrap_err()
                .contains("changed"));
            drop(workspace);
            assert!(!path.exists());
            assert_eq!(
                fs::read_to_string(repo.join("source.txt")).unwrap(),
                "uncommitted changes"
            );
            fs::remove_dir_all(repo).unwrap();
        }
    }

    #[test]
    fn commands_keep_workspace_ownership_and_close_idempotently() {
        assert!(issue_triage_validate("missing".into(), json!({})).is_err());
        issue_triage_close("missing".into()).unwrap();
    }
}
