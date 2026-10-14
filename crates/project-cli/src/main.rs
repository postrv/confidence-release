// SPDX-License-Identifier: Apache-2.0
use clap::{Parser, Subcommand};
use confidence_cli::{
    Result,
    archive::{Inspection, RepositoryArchive},
    canonical,
    client::{self, Client},
    digest,
    journal::{self, RequestRecord},
    random_id, repository,
};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    process::ExitCode,
};

#[derive(Parser)]
#[command(
    name = "confidence",
    version,
    about = "Inspect and import committed local Git repositories into Confidence",
    long_about = "Inspect and import committed local Git repositories into Confidence. Local inspection never executes repository hooks, filters, package scripts or remote operations. Uploads use the application's human Cloudflare Access identity; GitHub credentials are unnecessary."
)]
struct Args {
    /// Use only the loopback development server, without Cloudflare credentials.
    #[arg(long, global = true)]
    local: bool,
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
    /// Read a local committed repository without uploading anything.
    Repo {
        #[command(subcommand)]
        command: RepoCommand,
    },
    /// List, create and import projects using your application permissions.
    Project {
        #[command(subcommand)]
        command: ProjectCommand,
    },
    /// Sign in using Cloudflare's browser-assisted end-user Access flow.
    Auth {
        #[command(subcommand)]
        command: AuthCommand,
    },
}
#[derive(Subcommand)]
enum RepoCommand {
    /// Inspect exact HEAD, local exclusions, resource limits and proposed checks.
    Inspect {
        #[arg(default_value = ".")]
        path: PathBuf,
        #[arg(long)]
        json: bool,
    },
    /// Write a private portable archive for later import with project import-archive.
    Pack {
        #[arg(default_value = ".")]
        path: PathBuf,
        #[arg(long)]
        output: PathBuf,
    },
}
#[derive(Subcommand)]
enum AuthCommand {
    Login {
        #[arg(long)]
        target: String,
    },
}
#[derive(Subcommand)]
enum ProjectCommand {
    /// List only projects visible to the current identity.
    List {
        #[arg(long)]
        target: String,
    },
    /// Create a project. Keep its journal to recover any uncertain response.
    Create {
        #[arg(long)]
        target: String,
        #[arg(long)]
        name: String,
        #[arg(long, default_value = "")]
        description: String,
        #[arg(long)]
        journal: Option<PathBuf>,
        #[arg(long)]
        confirm: bool,
    },
    /// Upload exact committed HEAD to an empty project, or create one with --name.
    Import {
        #[arg(default_value = ".")]
        path: PathBuf,
        #[arg(long)]
        target: String,
        #[arg(long, required_unless_present = "name", conflicts_with = "name")]
        project: Option<String>,
        #[arg(long, required_unless_present = "project", conflicts_with = "project")]
        name: Option<String>,
        /// Import request journal; when creating first, .create.json is retained beside it.
        #[arg(long)]
        journal: Option<PathBuf>,
        /// Confirm uploading the displayed committed snapshot and check configuration.
        #[arg(long)]
        confirm: bool,
    },
    /// Upload an already packed archive without reopening or changing its source.
    ImportArchive {
        archive: PathBuf,
        #[arg(long)]
        target: String,
        #[arg(long, required_unless_present = "name", conflicts_with = "name")]
        project: Option<String>,
        #[arg(long, required_unless_present = "project", conflicts_with = "project")]
        name: Option<String>,
        #[arg(long)]
        journal: Option<PathBuf>,
        #[arg(long)]
        confirm: bool,
    },
    /// Replay a saved request with the same target, identity, body and idempotency key.
    Resume {
        journal: PathBuf,
        #[arg(long)]
        confirm: bool,
    },
}
fn main() -> ExitCode {
    match run(Args::parse()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("Error: {error}");
            ExitCode::from(1)
        }
    }
}
fn inspect(path: &Path) -> Result<(RepositoryArchive, Inspection)> {
    let snapshot = repository::snapshot(path)?;
    let archive = RepositoryArchive::from_snapshot(&snapshot);
    let inspection = archive.inspect(&snapshot)?;
    Ok((archive, inspection))
}
fn print_inspection(inspection: &Inspection) {
    eprintln!("Committed HEAD: {}", inspection.head);
    eprintln!(
        "{} files, {} objects, {} raw bytes; {} archive bytes",
        inspection.file_count,
        inspection.object_count,
        inspection.object_bytes,
        inspection.archive_bytes
    );
    eprintln!("Archive digest: {}", inspection.archive_digest);
    eprintln!(
        "{} detected repository checks (configuration only; import does not execute them)",
        inspection.checks.len()
    );
    eprintln!(
        "Import preserves saved project checks. Detected checks initialize an empty configuration."
    );
    for warning in &inspection.warnings {
        eprintln!("- {warning}");
    }
}
fn run(args: Args) -> Result<()> {
    let local = args.local;
    match args.command {
        Command::Auth {
            command: AuthCommand::Login { target },
        } => {
            if local {
                return Err("Local development does not use Cloudflare Access login".into());
            }
            client::login(&target)?;
            eprintln!(
                "Cloudflare Access login completed. Project permissions are checked by the application."
            );
        }
        Command::Repo {
            command: RepoCommand::Inspect { path, json },
        } => {
            let (_, inspection) = inspect(&path)?;
            if json {
                println!("{}", serde_json::to_string_pretty(&inspection).unwrap());
            } else {
                print_inspection(&inspection);
            }
        }
        Command::Repo {
            command: RepoCommand::Pack { path, output },
        } => {
            let (archive, inspection) = inspect(&path)?;
            print_inspection(&inspection);
            journal::write_new(&output, &archive.bytes()?)?;
            eprintln!(
                "Archive saved to {}. Use `confidence project import-archive FILE --target ORIGIN --project ID --confirm`. The archive contains private committed source.",
                output.display()
            );
        }
        Command::Project {
            command: ProjectCommand::List { target },
        } => {
            let client = Client::connect_mode(&target, local)?;
            println!(
                "{}",
                serde_json::to_string_pretty(&client.get("/api/projects")?).unwrap()
            );
        }
        Command::Project {
            command:
                ProjectCommand::Create {
                    target,
                    name,
                    description,
                    journal,
                    confirm,
                },
        } => {
            let target = client::target_origin_mode(&target, local)?;
            validate_name(&name)?;
            if description.len() > 2048 {
                return Err("Description exceeds 2,048 bytes".into());
            }
            if !confirm {
                eprintln!(
                    "Create project {:?} at {target}. Add --confirm to create it.",
                    name
                );
                return Ok(());
            }
            let client = Client::connect_mode(&target, local)?;
            let command_id = random_id()?;
            let path = journal.unwrap_or(journal::default_path(&command_id)?);
            let value = create_project(&client, &name, &description, &path, command_id)?;
            println!("{}", serde_json::to_string_pretty(&value).unwrap());
        }
        Command::Project {
            command:
                ProjectCommand::Import {
                    path,
                    target,
                    project,
                    name,
                    journal,
                    confirm,
                },
        } => {
            let (archive, inspection) = inspect(&path)?;
            print_inspection(&inspection);
            import(archive, &target, project, name, journal, confirm, local)?;
        }
        Command::Project {
            command:
                ProjectCommand::ImportArchive {
                    archive,
                    target,
                    project,
                    name,
                    journal,
                    confirm,
                },
        } => {
            let archive = RepositoryArchive::read(&archive)?;
            eprintln!(
                "Packed HEAD: {}; {} objects; digest {}",
                archive.head,
                archive.objects.len(),
                digest(&archive.bytes()?)
            );
            for warning in &archive.warnings {
                eprintln!("- {warning}");
            }
            import(archive, &target, project, name, journal, confirm, local)?;
        }
        Command::Project {
            command:
                ProjectCommand::Resume {
                    journal: path,
                    confirm,
                },
        } => {
            let record = journal::read(&path)?;
            if record.local_development != local {
                return Err("Use --local only when resuming a local-development journal; production journals always require Access authentication".into());
            }
            client::target_origin_mode(&record.target, local)?;
            eprintln!(
                "Saved request {}: {}{}",
                record.command_id, record.target, record.route
            );
            if !confirm {
                eprintln!(
                    "Add --confirm to replay this exact saved request. Its identity and idempotency key will be preserved."
                );
                return Ok(());
            }
            let client = Client::connect_mode(&record.target, local)?;
            let response = dispatch(&client, &path, &record, false)?;
            verify_readback(&client, &record, &response)?;
            println!("{}", serde_json::to_string_pretty(&response).unwrap());
        }
    }
    Ok(())
}
fn import(
    archive: RepositoryArchive,
    target: &str,
    project: Option<String>,
    name: Option<String>,
    journal: Option<PathBuf>,
    confirm: bool,
    local: bool,
) -> Result<()> {
    let target = client::target_origin_mode(target, local)?;
    if let Some(id) = &project {
        validate_project_id(id)?;
    }
    if let Some(name) = &name {
        validate_name(name)?;
    }
    if !confirm {
        eprintln!("Target: {target}. Add --confirm to upload this exact committed snapshot.");
        return Ok(());
    }
    let client = Client::connect_mode(&target, local)?;
    let command_id = random_id()?;
    let path = journal.unwrap_or(journal::default_path(&command_id)?);
    let project_id = if let Some(id) = project {
        id
    } else {
        let create_path = PathBuf::from(format!("{}.create.json", path.display()));
        let value = create_project(
            &client,
            name.as_deref().unwrap(),
            "",
            &create_path,
            random_id()?,
        )?;
        field(&value, "projectId")?.to_owned()
    };
    let metadata = client.get(&format!("/api/projects/{project_id}"))?;
    if metadata
        .get("source")
        .and_then(|source| source.get("status"))
        .and_then(Value::as_str)
        != Some("EMPTY")
    {
        return Err("Project already has a source. Import into a new empty project; existing source is never silently replaced.".into());
    }
    if metadata.get("status").and_then(Value::as_str) != Some("ACTIVE") {
        return Err("Project must be active before import".into());
    }
    let record = RequestRecord {
        schema_version: 1,
        target,
        principal_id: client.principal()?,
        local_development: local,
        command_id,
        route: format!("/api/projects/{project_id}/import"),
        expected_revision: Some(field(&metadata, "revision")?.into()),
        expected_incarnation: Some(field(&metadata, "projectIncarnation")?.into()),
        body: json!({"archive":archive}),
    };
    let response = dispatch(&client, &path, &record, true)?;
    verify_readback(&client, &record, &response)?;
    println!("{}", serde_json::to_string_pretty(&response).unwrap());
    Ok(())
}
fn create_project(
    client: &Client,
    name: &str,
    description: &str,
    path: &Path,
    command_id: String,
) -> Result<Value> {
    let record = RequestRecord {
        schema_version: 1,
        target: client.origin().into(),
        principal_id: client.principal()?,
        local_development: client.local_development(),
        command_id,
        route: "/api/projects".into(),
        expected_revision: None,
        expected_incarnation: None,
        body: json!({"name":name,"description":description}),
    };
    let response = dispatch(client, path, &record, true)?;
    verify_readback(client, &record, &response)?;
    Ok(response)
}
fn dispatch(client: &Client, path: &Path, record: &RequestRecord, create: bool) -> Result<Value> {
    if create {
        journal::create(path, record)?;
    }
    eprintln!("Durable request: {}", path.display());
    eprintln!(
        "If interrupted, recover with: confidence project resume {:?} --confirm",
        path
    );
    let (status, response) = client.send(record)?;
    journal::record_response(path, status, &response)?;
    if status != 200 && status != 201 {
        return Err(format!(
            "Request returned HTTP {status}: {}. The exact response is retained beside its request journal.",
            client::error_code(&response)
        ));
    }
    Ok(response)
}
fn verify_readback(client: &Client, record: &RequestRecord, response: &Value) -> Result<()> {
    let project = field(response, "projectId")?;
    validate_project_id(project)?;
    let observed = client.get(&format!("/api/projects/{project}"))?;
    if field(response, "projectIncarnation")? != field(&observed, "projectIncarnation")? {
        return Err("Project incarnation changed after command; preserve the journal and inspect the project".into());
    }
    if record.route.ends_with("/import") {
        let archive = record
            .body
            .get("archive")
            .ok_or("Import journal is missing archive")?;
        let expected = digest(canonical(archive).as_bytes());
        let source = observed
            .get("source")
            .ok_or("Project readback is missing source")?;
        if source.get("status").and_then(Value::as_str) != Some("IMPORTED")
            || field(source, "archiveDigest")? != expected
            || field(source, "head")? != field(archive, "head")?
        {
            return Err("Import readback did not match the submitted HEAD and archive digest; preserve the journal".into());
        }
        eprintln!(
            "Independent project readback confirmed the exact imported HEAD and archive digest."
        );
    } else {
        eprintln!("Project creation confirmed by a separate readback.");
    }
    Ok(())
}
fn field<'a>(value: &'a Value, name: &str) -> Result<&'a str> {
    value
        .get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Application response lacks {name}"))
}
fn validate_project_id(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Err("Invalid project ID".into());
    }
    Ok(())
}
fn validate_name(value: &str) -> Result<()> {
    if value.trim().is_empty() || value.len() > 120 {
        Err("Project name must contain 1–120 bytes".into())
    } else {
        Ok(())
    }
}
