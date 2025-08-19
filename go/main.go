package main

import (
	"fmt"
	"log"
	"os"

	"picpurge/cmd" // Import the cmd package
	"picpurge/database"
)

func main() {
	// Connect to the database
	err := database.ConnectDb()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: Failed to connect to database: %v\n", err)
		os.Exit(1)
	}
	defer func() {
		if err := database.CloseDb(); err != nil {
			fmt.Fprintf(os.Stderr, "Error: Failed to close database connection: %v\n", err)
			os.Exit(1)
		}
	}()

	log.Println("PicPurge Go application started.")

	cmd.Execute() // Call Execute from the cmd package
}
