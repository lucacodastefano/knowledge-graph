// KnowledgeGraph launcher: starts the bundled Node runtime with the app, opens the canvas in the browser.
// Layout next to the executable: runtime/node(.exe), app/dist/server/cli.js, data/ (created on first run).
package main

import (
	"bufio"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

func fail(format string, a ...any) {
	fmt.Fprintf(os.Stderr, "\nErrore: "+format+"\n", a...)
	fmt.Fprint(os.Stderr, "\nPremi Invio per chiudere.")
	bufio.NewReader(os.Stdin).ReadString('\n')
	os.Exit(1)
}

func port() string {
	if p := os.Getenv("KG_PORT"); p != "" {
		return p
	}
	return "7777"
}

func healthy(base string) bool {
	c := http.Client{Timeout: 1500 * time.Millisecond}
	res, err := c.Get(base + "/api/health")
	if err != nil {
		return false
	}
	res.Body.Close()
	return res.StatusCode == 200
}

func openBrowser(url string) {
	switch runtime.GOOS {
	case "windows":
		exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	case "darwin":
		exec.Command("open", url).Start()
	default:
		exec.Command("xdg-open", url).Start()
	}
}

func main() {
	exe, err := os.Executable()
	if err != nil {
		fail("%v", err)
	}
	root := filepath.Dir(exe)
	node := filepath.Join(root, "runtime", "node")
	if runtime.GOOS == "windows" {
		node += ".exe"
	}
	cli := filepath.Join(root, "app", "dist", "server", "cli.js")
	for _, p := range []string{node, cli} {
		if _, err := os.Stat(p); err != nil {
			fail("file mancante: %s\nHai estratto tutta la cartella dallo zip? Non lanciare l'eseguibile da dentro lo zip.", p)
		}
	}
	data := filepath.Join(root, "data")
	if err := os.MkdirAll(data, 0o755); err != nil {
		fail("impossibile creare la cartella dati %s: %v", data, err)
	}
	db := os.Getenv("KG_DB")
	if db == "" {
		db = filepath.Join(data, "graph.db")
	}
	env := append(os.Environ(), "KG_DB="+db)
	base := "http://127.0.0.1:" + port()
	url := "http://localhost:" + port()

	arg := ""
	if len(os.Args) > 1 {
		arg = strings.ToLower(os.Args[1])
	}
	switch arg {
	case "--configura-claude", "--configure-claude":
		cmd := exec.Command(node, cli, "configure-claude", "--db", db)
		cmd.Env, cmd.Stdout, cmd.Stderr = env, os.Stdout, os.Stderr
		if err := cmd.Run(); err != nil {
			fail("configurazione di Claude Desktop non riuscita (vedi sopra).")
		}
		return
	case "--ferma", "--stop":
		res, err := http.Post(base+"/api/shutdown", "application/json", strings.NewReader("{}"))
		if err != nil {
			fmt.Println("Knowledge Graph non è in esecuzione.")
			return
		}
		res.Body.Close()
		if res.StatusCode >= 300 {
			fail("lo stop è stato rifiutato (HTTP %d).", res.StatusCode)
		}
		fmt.Println("Knowledge Graph fermato.")
		return
	case "":
	default:
		fail("opzione sconosciuta: %s\nOpzioni: --configura-claude, --ferma", os.Args[1])
	}

	if healthy(base) {
		fmt.Println("Knowledge Graph è già in esecuzione, apro il browser.")
		openBrowser(url)
		return
	}
	fmt.Printf("Knowledge Graph in avvio su %s\nDati: %s\nChiudi questa finestra per fermarlo.\n\n", url, db)
	cmd := exec.Command(node, "--disable-warning=ExperimentalWarning", cli, "serve")
	cmd.Env, cmd.Stdout, cmd.Stderr = env, os.Stdout, os.Stderr
	if err := cmd.Start(); err != nil {
		fail("avvio non riuscito: %v", err)
	}
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	for i := 0; i < 100; i++ {
		select {
		case err := <-exited:
			fail("il server si è fermato subito (%v). La porta %s è forse occupata da un altro programma?", err, port())
		case <-time.After(150 * time.Millisecond):
		}
		if healthy(base) {
			openBrowser(url)
			break
		}
	}
	if err := <-exited; err != nil {
		fail("il server si è fermato: %v", err)
	}
}
