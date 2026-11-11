/// The same layout as the Local CLI's help (ADR 20261110-235800).
const HELP: &str = "Usage: room-cli [command]

Cloudroom CLI in a Cloud thread: this thread, its children, and this sandbox

Commands:
  status        Show this thread and its children
  thread        Manage this thread and its child threads
  provider      List the agents and models a child thread can use
  loop          Schedule work for this thread (alias: automation)
  mac           Run commands and copy files on the user's computer
  secret        Ask the user for API keys
  files         Wait for the project's files
  preview       Show a web app through the user's browser
  computer-use  Control this sandbox's screen
  gpu           Rent a GPU box
  usage         Show the account's Cloud Credits
  feedback      Send Cloudroom a bug, friction, or idea

Add --help to any command. Other threads, projects, settings and plugins live in the Cloudroom app on the user's computer: see the room-cli skill.";

#[tokio::main(worker_threads = 2)]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // `std::env::args()` panics on an argument that isn't UTF-8 (#705).
    let mut args = Vec::new();
    for (index, arg) in std::env::args_os().enumerate().skip(1) {
        match arg.into_string() {
            Ok(arg) => args.push(arg),
            Err(arg) => {
                eprintln!(
                    "Argument {index} isn't valid UTF-8: {}. Pass text; send bytes on stdin instead (room-cli mac run --stdin).",
                    arg.to_string_lossy()
                );
                std::process::exit(2);
            }
        }
    }
    if args.first().map(String::as_str) == Some("--version") {
        println!("cloudroom {} ({})", cloudroom::VERSION, cloudroom::COMMIT);
        return Ok(());
    }
    if args.first().map(String::as_str) == Some("--features") {
        println!("{}", cloudroom::FEATURES.join("\n"));
        return Ok(());
    }
    if args.first().map(String::as_str) == Some("helper") {
        if let Err(error) = cloudroom::helper::cli(&args[1..]).await {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return Ok(());
    }
    if args.first().map(String::as_str) == Some("preview") {
        cloudroom::preview::cli(&args[1..]).await?;
        return Ok(());
    }
    if args.first().map(String::as_str) == Some("mac") {
        match cloudroom::mac::cli(&args[1..]).await {
            Ok(code) => std::process::exit(code),
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
    }
    if args.first().map(String::as_str) == Some("secret") {
        match cloudroom::secrets::cli(&args[1..]).await {
            Ok(code) => std::process::exit(code),
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
    }
    if args.first().map(String::as_str) == Some("thread") {
        match cloudroom::session::thread::cli(&args[1..]).await {
            Ok(code) => std::process::exit(code),
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
    }
    if matches!(
        args.first().map(String::as_str),
        Some("status" | "provider")
    ) {
        let result = match args[0].as_str() {
            "status" => cloudroom::session::info::status_cli(&args[1..]).await,
            _ => cloudroom::session::info::provider_cli(&args[1..]).await,
        };
        match result {
            Ok(code) => std::process::exit(code),
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
    }
    if matches!(
        args.first().map(String::as_str),
        Some("feedback" | "report")
    ) {
        match cloudroom::session::report::cli(&args[1..]).await {
            Ok(code) => std::process::exit(code),
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
    }
    if args.first().map(String::as_str) == Some("usage") {
        match cloudroom::session::report::usage_cli(&args[1..]).await {
            Ok(code) => std::process::exit(code),
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
    }
    if matches!(
        args.first().map(String::as_str),
        Some("automation" | "loop")
    ) {
        match cloudroom::session::automation::cli(&args[1..]).await {
            Ok(code) => std::process::exit(code),
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
    }
    if args.first().map(String::as_str) == Some("files") {
        match cloudroom::workspace::files::cli(&args[1..]).await {
            Ok(code) => std::process::exit(code),
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
    }
    if args.first().map(String::as_str) == Some("computer-use") {
        match cloudroom::computer_use::cli(&args[1..]).await {
            Ok(code) => std::process::exit(code),
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
    }
    if args.first().map(String::as_str) == Some("gpu") {
        match cloudroom::gpu::cli(&args[1..]).await {
            Ok(code) => std::process::exit(code),
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
    }
    if args.first().map(String::as_str) == Some("--gpu-skill") {
        print!("{}", cloudroom::gpu::SKILL);
        return Ok(());
    }
    if args.first().map(String::as_str) == Some("--computer-use-skill") {
        print!("{}", cloudroom::computer_use::SKILL);
        return Ok(());
    }
    if args.first().map(String::as_str) == Some("--secrets-skill") {
        print!("{}", cloudroom::secrets::SKILL);
        return Ok(());
    }
    if args.first().map(String::as_str) == Some("--mac-skill") {
        print!("{}", cloudroom::mac::SKILL);
        return Ok(());
    }
    if args.first().map(String::as_str) == Some("--room-cli-skill") {
        print!("{}", cloudroom::mac::ROOM_CLI_SKILL);
        return Ok(());
    }
    if args.first().map(String::as_str) == Some("--preview-skill") {
        print!("{}", cloudroom::preview::SKILL);
        return Ok(());
    }
    if args.first().map(String::as_str) == Some("--preview-authorized-keys") {
        if args.len() != 4 || args[3] != "cloudroom-preview" {
            return Err("invalid preview key lookup".into());
        }
        cloudroom::preview::authorized_keys(std::path::Path::new(&args[1]), args[2].parse()?)?;
        return Ok(());
    }
    if args.first().map(String::as_str) == Some("--cursor-driver") {
        let binary = args.get(1).ok_or("missing Cursor binary")?;
        cloudroom::runtime::cursor_print::run(binary)?;
        return Ok(());
    }
    if args.first().map(String::as_str) == Some("--clean-npm-cache") {
        let root = std::env::args_os().nth(2).ok_or("missing cache root")?;
        let groups = std::env::args_os()
            .nth(3)
            .ok_or("missing workload groups")?;
        cloudroom::workspace::storage::clean_npm_cache(
            std::path::Path::new(&root),
            std::path::Path::new(&groups),
        )?;
        return Ok(());
    }
    // The service starts without arguments; anything else is a mistyped agent command.
    if let Some(command) = args.first() {
        if matches!(command.as_str(), "--help" | "-h" | "help") {
            println!("{HELP}");
            return Ok(());
        }
        if cloudroom::session::info::LOCAL_ONLY.contains(&command.as_str()) {
            eprintln!("{}", cloudroom::session::info::on_computer(command));
        } else {
            eprintln!("Unknown command {command}.\n\n{HELP}");
        }
        std::process::exit(2);
    }
    cloudroom::serve(cloudroom::config::Config::from_env()?).await
}
