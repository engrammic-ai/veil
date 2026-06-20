package main

import (
	_ "embed"
	"log"
	"net/http"
	"os"
)

//go:embed install.sh
var installScriptSh []byte

//go:embed install.ps1
var installScriptPs1 []byte

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	http.HandleFunc("/", handleRoot)
	http.HandleFunc("/install", handleInstallSh)
	http.HandleFunc("/install.sh", handleInstallSh)
	http.HandleFunc("/install.ps1", handleInstallPs1)
	http.HandleFunc("/health", handleHealth)

	log.Printf("Starting server on :%s", port)
	if err := http.ListenAndServe(":"+port, nil); err != nil {
		log.Fatal(err)
	}
}

func handleRoot(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	http.Redirect(w, r, "https://github.com/engrammic-ai/veil", http.StatusFound)
}

func handleInstallSh(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Write(installScriptSh)
}

func handleInstallPs1(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Write(installScriptPs1)
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	w.Write([]byte("ok"))
}
